import { ipc } from "@/ipc/manager";

interface FaceIdentityRecord {
  coverPhotoPath?: string | null;
  coverThumbnailPath?: string | null;
  id: number;
  name: string;
}
export const searchCandidateActions = {
  tags: () => ipc.client.photos.getTags({}),
  exif: () => ipc.client.photos.getExifCandidates({}),
  people: async (): Promise<FaceIdentityRecord[]> => {
    const faceClient = (
      ipc.client as unknown as {
        faces?: {
          listFaceIdentities: (
            input: Record<string, never>
          ) => Promise<FaceIdentityRecord[]>;
        };
      }
    ).faces;
    return (await faceClient?.listFaceIdentities({})) ?? [];
  },
};
