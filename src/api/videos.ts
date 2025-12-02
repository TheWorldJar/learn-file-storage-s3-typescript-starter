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

  const ratio = await getVideoAspectRatio(videoFullName);
  const processed = await processVideoForFastStart(videoFullName);

  const s3Path = `videos/${ratio}/${videoFileName}.${mime.extension(videoFileType)}`;
  const s3File = cfg.s3Client.file(s3Path);
  s3File.write(Bun.file(processed), { type: videoFileType });

  Bun.file(videoFullName).delete();
  Bun.file(processed).delete();

  video.videoURL = `${cfg.s3CfDistribution}/${s3Path}`;
  updateVideo(cfg.db, video);
  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await proc.exited;

  let output, err;
  const exitCode = proc.exitCode;
  if (exitCode !== 0) {
    err = await new Response(proc.stderr).json();
    throw new Error(`Server Error: Processing Aspect Ratio ${err}`);
  }
  output = await new Response(proc.stdout).json();

  const videoHeight = output.streams[0].height,
    videoWidth = output.streams[0].width;
  const ratio = videoWidth / videoHeight;

  if (ratio > 1.7 && ratio < 1.8) {
    return "landscape";
  } else if (ratio > 0.5 && ratio < 0.6) {
    return "portrait";
  } else {
    return "other";
  }
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`;

  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputFilePath,
  ]);
  await proc.exited;

  return outputFilePath;
}
