/** DynamoDB client construction — the single place endpoint/credential wiring lives. */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { Config } from "../config.js";

/**
 * Builds a document client.
 *
 * DynamoDB Local rejects requests with no credentials at all, but does not check
 * them, so a placeholder pair is supplied when an endpoint override is in play and
 * no real credentials were configured. Against real AWS, credentials are left to
 * the default provider chain (environment, SSO, or the instance role) rather than
 * being read from config — an EC2 instance profile is the goal, not static keys.
 */
export function createDocumentClient(config: Config): DynamoDBDocumentClient {
  const isLocal = config.DYNAMODB_ENDPOINT !== undefined;
  const hasStaticCredentials =
    config.AWS_ACCESS_KEY_ID !== undefined && config.AWS_SECRET_ACCESS_KEY !== undefined;

  const client = new DynamoDBClient({
    region: config.AWS_REGION,
    ...(config.DYNAMODB_ENDPOINT !== undefined ? { endpoint: config.DYNAMODB_ENDPOINT } : {}),
    ...(hasStaticCredentials
      ? {
          credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID ?? "",
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY ?? "",
          },
        }
      : isLocal
        ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
  });

  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      /* Optional fields are modelled as absent, not as null attributes. */
      removeUndefinedValues: true,
      convertClassInstanceToMap: false,
    },
  });
}
