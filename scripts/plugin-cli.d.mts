export interface PluginCliManifestResult {
  assets: string[];
  id: string;
  locale?: {
    catalogVersion: string;
    mainFile: string;
    nativeName: string;
    rendererFile: string;
    tag: string;
  };
  signed?: boolean;
  version: string;
}

export interface PluginCliPackageResult extends PluginCliManifestResult {
  files: Map<string, Buffer>;
  manifest: Record<string, unknown>;
  theme?: Record<string, unknown>;
}

export interface PluginCliPackOptions {
  keyId?: string;
  out?: string;
  signingKeyPath?: string;
  signKey?: string;
}

export interface PluginCliPackedResult extends PluginCliPackageResult {
  entries: string[];
  outputPath: string;
}

export class PluginCliError extends Error {
  constructor(message: string);
}

export function validateManifest(
  manifest: unknown,
  theme?: unknown,
  assets?: ReadonlySet<string>
): PluginCliManifestResult;

export function validatePluginDirectory(
  directory: string
): Promise<PluginCliPackageResult>;

export function validatePluginPackage(
  archivePath: string
): Promise<PluginCliPackageResult>;

export function validatePlugin(
  inputPath: string
): Promise<PluginCliPackageResult>;

export function packPlugin(
  directory: string,
  options?: PluginCliPackOptions
): Promise<PluginCliPackedResult>;

export function runCli(args?: readonly string[]): Promise<number>;
