import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import { loadProcessEnv } from "../config/env.js";

type PutTextInput = {
  key: string;
  text: string;
  contentType?: string;
  metadata?: Record<string, string>;
};

type StoredTextObject = {
  text: string;
  metadata: Record<string, string>;
};

function isBucketMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "NotFound" ||
    error.name === "NoSuchBucket" ||
    error.message.includes("NotFound")
  );
}

export function createObjectStore() {
  const env = loadProcessEnv();
  const client = new S3Client({
    credentials: {
      accessKeyId: env.minio.accessKey,
      secretAccessKey: env.minio.secretKey
    },
    endpoint: env.minio.endpoint,
    forcePathStyle: true,
    region: env.minio.region
  });
  const bucket = env.minio.bucket;

  return {
    async ensureBucket(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!isBucketMissing(error)) {
          throw error;
        }

        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },

    async putText(input: PutTextInput): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Body: input.text,
          Bucket: bucket,
          ContentType: input.contentType,
          Key: input.key,
          Metadata: input.metadata
        })
      );
    },

    async getText(key: string): Promise<StoredTextObject> {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key
        })
      );

      if (!response.Body) {
        throw new Error(`Object ${key} returned an empty body`);
      }

      return {
        text: await response.Body.transformToString(),
        metadata: response.Metadata ?? {}
      };
    }
  };
}
