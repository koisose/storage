import * as odd from "@oddjs/odd";
import { getRecoil, setRecoil } from "recoil-nexus";
import type FileSystem from "@oddjs/odd/fs/index";
import type PublicFile from "@oddjs/odd/fs/v1/PublicFile";
import type PrivateFile from "@oddjs/odd/fs/v1/PrivateFile";
import { isFile } from "@oddjs/odd/fs/types/check";

import { filesystemStore } from "../../../stores";
import { galleryStore, AREAS } from "../stores";
import { addNotification } from "../../../lib/notifications";
import { fileToUint8Array } from "../../../lib/utils";

export type Image = {
  cid: string;
  ctime: number;
  name: string;
  private: boolean;
  size: number;
  src: string;
};

export type GALLERY = {
  publicImages: Image[];
  privateImages: Image[];
  selectedArea: AREAS;
  loading: boolean;
};

type Link = {
  size: number;
};

export const GALLERY_DIRS = {
  [AREAS.PUBLIC]: odd.path.directory("public", "gallery"),
  [AREAS.PRIVATE]: odd.path.directory("private", "gallery"),
};
const FILE_SIZE_LIMIT = 20;

/**
 * Create additional directories and files needed by the gallery if they don't exist
 *
 * @param fs FileSystem
 */

export const initializeFilesystem = async (fs: FileSystem): Promise<void> => {
  const publicPathExists = await fs.exists(
    GALLERY_DIRS[AREAS.PUBLIC]
  );
  const privatePathExists = await fs.exists(
    GALLERY_DIRS[AREAS.PRIVATE]
  );

  if (!publicPathExists) {
    await fs.mkdir(GALLERY_DIRS[AREAS.PUBLIC]);
  }

  if (!privatePathExists) {
    await fs.mkdir(GALLERY_DIRS[AREAS.PRIVATE]);
  }
};

/**
 * Get images from the user's WNFS and construct the `src` value for the images
 */

export const getImagesFromWNFS: () => Promise<void> = async () => {
  const gallery = getRecoil(galleryStore);
  const fs = getRecoil(filesystemStore);
  if (!fs) return;

  try {
    // Set loading: true on the galleryStore
    setRecoil(galleryStore, { ...gallery, loading: true });

    const { selectedArea } = gallery;
    const isPrivate = selectedArea === AREAS.PRIVATE;

    // Set path to either private or public gallery dir
    const path = GALLERY_DIRS[selectedArea];

    // Get list of links for files in the gallery dir
    const links = await fs.ls(path);

    let images = await Promise.all(
      Object.entries(links).map(async ([name]) => {
        const file = await fs.get(
          odd.path.combine(GALLERY_DIRS[selectedArea], odd.path.file(`${name}`))
        );

        if (!isFile(file)) return null;

        // The CID for private files is currently located in `file.header.content`,
        // whereas the CID for public files is located in `file.cid`
        const cid = isPrivate
          ? (file as PrivateFile).header.content.toString()
          : (file as PublicFile).cid.toString();

        // Create a blob to use as the image `src`
        const blob = new Blob([file.content]);
        const src = URL.createObjectURL(blob);

        const ctime = isPrivate
          ? (file as PrivateFile).header.metadata.unixMeta.ctime
          : (file as PublicFile).header.metadata.unixMeta.ctime;

        return {
          cid,
          ctime,
          name,
          private: isPrivate,
          size: (links[name] as Link).size,
          src,
        };
      })
    );

    // Sort images by ctime(created at date)
    // NOTE: this will eventually be controlled via the UI
    images = images.filter((a) => !!a);
    images.sort((a, b) => b.ctime - a.ctime);

    // Push images to the galleryStore
    setRecoil(galleryStore, {
      ...gallery,
      ...(isPrivate
        ? {
            privateImages: images,
          }
        : {
            publicImages: images,
          }),
      loading: false,
    });
  } catch (error) {
    setRecoil(galleryStore, {
      ...gallery,
      loading: false,
    });
  }
};

/**
 * Upload an image to the user's private or public WNFS
 * @param image
 */

export const uploadImageToWNFS: (image: File) => Promise<void> = async (
  image
) => {
  const gallery = getRecoil(galleryStore);
  const fs = getRecoil(filesystemStore);
  if (!fs) return;

  try {
    const { selectedArea } = gallery;

    // Reject files over 20MB
    const imageSizeInMB = image.size / (1024 * 1024);
    if (imageSizeInMB > FILE_SIZE_LIMIT) {
      throw new Error("Image can be no larger than 20MB");
    }

    // Reject the upload if the image already exists in the directory
    const imageExists = await fs.exists(
      odd.path.combine(GALLERY_DIRS[ selectedArea ], odd.path.file(image.name))
    );
    if (imageExists) {
      throw new Error(`${image.name} image already exists`);
    }

    // Create a sub directory and add some content
    await fs.write(
      odd.path.combine(GALLERY_DIRS[ selectedArea ], odd.path.file(image.name)),
      await fileToUint8Array(image)
    );

    // Announce the changes to the server
    await fs.publish();

    addNotification({
      msg: `${image.name} image has been published`,
      type: "success",
    });
  } catch (error) {
    addNotification({ msg: (error as Error).message, type: "error" });
    console.error(error);
  }
};

/**
 * Delete an image from the user's private or public WNFS
 * @param name
 */
export const deleteImageFromWNFS: (name: string) => Promise<void> = async (
  name
) => {
  const gallery = getRecoil(galleryStore);
  const fs = getRecoil(filesystemStore);
  if (!fs) return;

  try {
    const { selectedArea } = gallery;

    const imageExists = await fs.exists(
      odd.path.combine(GALLERY_DIRS[ selectedArea ], odd.path.file(name))
    );

    if (imageExists) {
      // Remove images from server
      await fs.rm(
        odd.path.combine(GALLERY_DIRS[selectedArea], odd.path.file(name))
      );

      // Announce the changes to the server
      await fs.publish();

      addNotification({
        msg: `${name} image has been deleted`,
        type: "success",
      });

      // Refetch images and update galleryStore
      await getImagesFromWNFS();
    } else {
      throw new Error(`${name} image has already been deleted`);
    }
  } catch (error) {
    addNotification({ msg: (error as Error).message, type: "error" });
    console.error(error);
  }
};

/**
 * Handle uploads made by interacting with the file input directly
 */
export const handleFileInput: (
  files: FileList | null
) => Promise<void> = async (files) => {
  if (!files) return;

  await Promise.all(
    Array.from(files).map(async (file) => {
      await uploadImageToWNFS(file);
    })
  );

  // Refetch images and update galleryStore
  await getImagesFromWNFS();
};
