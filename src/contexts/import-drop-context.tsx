import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useRef } from "react";
import { useImportDropZones } from "@/hooks/use-import-drop-zones";

type ImageSearchHandler = (imagePath: string) => void | Promise<void>;

interface ImportDropContextValue {
  registerImageSearch: (handler: ImageSearchHandler) => () => void;
  zones: ReturnType<typeof useImportDropZones>;
}

const ImportDropContext = createContext<ImportDropContextValue | null>(null);

export function ImportDropProvider({ children }: { children: ReactNode }) {
  const imageSearchRef = useRef<ImageSearchHandler | null>(null);
  const registerImageSearch = useCallback((handler: ImageSearchHandler) => {
    imageSearchRef.current = handler;
    return () => {
      if (imageSearchRef.current === handler) {
        imageSearchRef.current = null;
      }
    };
  }, []);
  const onImageSearch = useCallback(async (imagePath: string) => {
    await imageSearchRef.current?.(imagePath);
  }, []);
  const zones = useImportDropZones({ onImageSearch });

  return (
    <ImportDropContext.Provider value={{ registerImageSearch, zones }}>
      {children}
    </ImportDropContext.Provider>
  );
}

export function useImportDropContext(): ImportDropContextValue {
  const context = useContext(ImportDropContext);
  if (!context) {
    throw new Error(
      "useImportDropContext must be used within <ImportDropProvider>"
    );
  }
  return context;
}
