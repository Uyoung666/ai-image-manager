import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export interface FileWatcherOptions {
  awaitWriteFinish: { stabilityThreshold: number; pollInterval: number };
  depth: number;
  ignored: RegExp[];
  ignoreInitial: boolean;
  ignorePermissionErrors: boolean;
}

export interface FileWatcherHandle {
  close(): Promise<void>;
  on(event: "add" | "unlink", listener: (path: string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "ready", listener: () => void): this;
}

interface WireError {
  code?: string;
  message: string;
  syscall?: string;
}
type WatchMessage =
  | { type: "event"; id: number; event: "add" | "unlink"; path: string }
  | { type: "ready"; id: number }
  | { type: "error"; id: number; error: WireError }
  | { type: "closed"; id: number; error?: WireError }
  | { type: "fatal"; error: WireError };

// Keep the existing chokidar options and event semantics, but register native
// handles on a separate host thread so fs.watch cannot block gallery HTTP/IPC.
const workerSource = `
const {parentPort,workerData}=require('node:worker_threads');
const watchers=new Map();
const wire=error=>({message:String(error?.message??error),code:error?.code,syscall:error?.syscall});
const post=message=>parentPort.postMessage(message);
(async()=>{
 const {default:chokidar}=await import(workerData.moduleUrl);
 parentPort.on('message',async message=>{
  if(message.type==='watch'){
   try{
    const watcher=chokidar.watch(message.path,message.options);
    watchers.set(message.id,watcher);
    watcher.on('error',error=>post({type:'error',id:message.id,error:wire(error)}));
    for(const event of ['add','unlink'])watcher.on(event,path=>post({type:'event',id:message.id,event,path}));
    watcher.once('ready',()=>post({type:'ready',id:message.id}));
   }catch(error){post({type:'error',id:message.id,error:wire(error)});}
  }else if(message.type==='close'){
   const watcher=watchers.get(message.id);
   watchers.delete(message.id);
   try{
    const closing=watcher?.close();
    watcher?.on('error',()=>{});
    await closing;
    post({type:'closed',id:message.id});
   }catch(error){
    watcher?.on('error',()=>{});
    post({type:'closed',id:message.id,error:wire(error)});
   }
  }
 });
})().catch(error=>post({type:'fatal',error:wire(error)}));
`;

const handles = new Map<number, BackgroundWatcher>();
let currentWorker: Worker | undefined;
let nextId = 0;
const hostRequire = createRequire(import.meta.url);

function fromWire(error: WireError): Error {
  return Object.assign(new Error(error.message), {
    code: error.code,
    syscall: error.syscall,
  });
}

function failWorker(worker: Worker, error: Error): void {
  if (currentWorker === worker) {
    currentWorker = undefined;
  }
  for (const handle of [...handles.values()]) {
    if (handle.worker === worker) {
      handles.delete(handle.id);
      handle.fail(error);
    }
  }
  worker.terminate().catch(() => undefined);
}

function getWorker(): Worker {
  if (currentWorker) {
    return currentWorker;
  }
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      moduleUrl: pathToFileURL(hostRequire.resolve("chokidar")).href,
    },
  });
  currentWorker = worker;
  worker.on("message", (message: WatchMessage) => {
    if (message.type === "fatal") {
      failWorker(worker, fromWire(message.error));
      return;
    }
    const handle = handles.get(message.id);
    if (handle?.worker === worker) {
      handle.receive(message);
    }
  });
  worker.on("error", (error) =>
    failWorker(
      worker,
      error instanceof Error ? error : new Error(String(error))
    )
  );
  worker.on("exit", (code) => {
    if ([...handles.values()].some((handle) => handle.worker === worker)) {
      failWorker(worker, new Error(`File watcher worker exited: ${code}`));
    }
  });
  return worker;
}

async function stopIdleWorker(worker: Worker): Promise<void> {
  if ([...handles.values()].some((handle) => handle.worker === worker)) {
    return;
  }
  if (currentWorker === worker) {
    currentWorker = undefined;
  }
  await worker.terminate();
}

class BackgroundWatcher extends EventEmitter implements FileWatcherHandle {
  readonly id = ++nextId;
  readonly worker: Worker;
  private closing = false;
  private failure?: Error;
  private closeTask?: Promise<void>;
  private closeResolve?: () => void;
  private closeReject?: (error: Error) => void;

  constructor(folderPath: string, options: FileWatcherOptions) {
    super();
    this.on("error", () => undefined);
    this.worker = getWorker();
    handles.set(this.id, this);
    try {
      this.worker.postMessage({
        type: "watch",
        id: this.id,
        path: folderPath,
        options,
      });
    } catch (error) {
      handles.delete(this.id);
      stopIdleWorker(this.worker).catch(() => undefined);
      throw error;
    }
  }

  receive(message: Exclude<WatchMessage, { type: "fatal" }>): void {
    if (message.type === "closed") {
      handles.delete(this.id);
      stopIdleWorker(this.worker).then(
        () => {
          if (message.error) {
            this.closeReject?.(fromWire(message.error));
          } else {
            this.closeResolve?.();
          }
        },
        (error: Error) => this.closeReject?.(error)
      );
    } else if (!this.closing) {
      if (message.type === "error") {
        this.emit("error", fromWire(message.error));
      } else if (message.type === "ready") {
        this.emit("ready");
      } else {
        this.emit(message.event, message.path);
      }
    }
  }

  fail(error: Error): void {
    this.failure = error;
    if (this.closing) {
      this.closeReject?.(error);
    } else {
      this.emit("error", error);
    }
  }

  close(): Promise<void> {
    if (this.closeTask) {
      return this.closeTask;
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    this.closing = true;
    this.removeAllListeners();
    this.closeTask = new Promise((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
    });
    try {
      this.worker.postMessage({ type: "close", id: this.id });
    } catch (error) {
      handles.delete(this.id);
      stopIdleWorker(this.worker).catch(() => undefined);
      this.closeReject?.(error as Error);
    }
    return this.closeTask;
  }
}

export function createBackgroundWatcher(
  folderPath: string,
  options: FileWatcherOptions
): FileWatcherHandle {
  return new BackgroundWatcher(folderPath, options);
}
