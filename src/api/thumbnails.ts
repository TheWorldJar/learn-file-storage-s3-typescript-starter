import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { cfg } from "../config";
import path from "path";
import { isUndefined } from "util";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const form = await req.formData();
  const thumbnail = form.get("thumbnail");
  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Invalid Thumbnail");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File Too Big");
  }
  const fileType = thumbnail.type;

  if (fileType !== "image/jpeg" && fileType !== "image/png") {
    throw new BadRequestError("Invalid File Type");
  }
  Bun.write(
    path.join(cfg.assetsRoot, videoId, fileType),
    await thumbnail.arrayBuffer(),
  );

  const thumbURL = `http://localhost:${cfg.port}/assets/${videoId}.${fileType}`;
  const video = getVideo(cfg.db, videoId);
  if (!isUndefined(video)) {
    video.thumbnailURL = thumbURL;
    updateVideo(cfg.db, video);
  }
  return respondWithJSON(200, video);
}
