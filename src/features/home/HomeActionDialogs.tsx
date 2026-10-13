import type { ComponentProps } from "react";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { CloudUploadDialog } from "@/components/CloudUploadDialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { CullStartDialog } from "@/components/CullStartDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";
import { ShareDialog } from "@/components/ShareDialog";

interface HomeActionDialogsProps {
  album: ComponentProps<typeof AddToAlbumDialog>;
  convert: ComponentProps<typeof FormatConvertDialog>;
  cull: ComponentProps<typeof CullStartDialog>;
  deletePhotos: ComponentProps<typeof ConfirmDeleteDialog>;
  exportPhotos: ComponentProps<typeof ExportDialog>;
  rename: ComponentProps<typeof BatchRenameDialog>;
  share: ComponentProps<typeof ShareDialog>;
  upload: ComponentProps<typeof CloudUploadDialog>;
}
export function HomeActionDialogs({
  rename,
  convert,
  album,
  exportPhotos,
  upload,
  share,
  deletePhotos,
  cull,
}: HomeActionDialogsProps) {
  return (
    <>
      <BatchRenameDialog {...rename} />
      <FormatConvertDialog {...convert} />
      <AddToAlbumDialog {...album} />
      <ExportDialog {...exportPhotos} />
      <CloudUploadDialog {...upload} />
      <ShareDialog {...share} />
      <ConfirmDeleteDialog {...deletePhotos} />
      <CullStartDialog {...cull} />
    </>
  );
}
