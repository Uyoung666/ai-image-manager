import { ipc } from "@/ipc/manager";

export const albumPickerActions = {
  list: () => ipc.client.albums.listAlbums({}),
  recent: () => ipc.client.albums.getRecentAlbums(),
  add: (input: Parameters<typeof ipc.client.albums.addPhotosToAlbum>[0]) =>
    ipc.client.albums.addPhotosToAlbum(input),
  create: (input: Parameters<typeof ipc.client.albums.createAlbum>[0]) =>
    ipc.client.albums.createAlbum(input),
};
