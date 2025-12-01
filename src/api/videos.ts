import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";
import mime from "mime-types";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const uploadLimit = 1 << 30;
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video Not Found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Forebidden");
  }

  console.log("uploading video for video", videoId, "by user", userID);

  const form = await req.formData();
  const videoFile = form.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Invalid Video");
  }
  if (videoFile.size > uploadLimit) {
    throw new BadRequestError("File Too Big");
  }

  const videoFileType = videoFile.type;
  if (videoFileType !== "video/mp4") {
    throw new BadRequestError("Invalid File Type");
  }
  const videoFileName = randomBytes(32).toString("base64url");
  const videoFullName = `${cfg.assetsRoot}/${videoFileName}.${mime.extension(videoFileType)}`;
  Bun.write(videoFullName, await videoFile.arrayBuffer());

  const s3File = cfg.s3Client.file(
    `${videoFileName}.${mime.extension(videoFileType)}`,
  );
  s3File.write(Bun.file(videoFullName), { type: videoFileType });

  Bun.file(videoFullName).delete();
  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${videoFileName}.${mime.extension(videoFileType)}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);
  return respondWithJSON(200, video);
}
