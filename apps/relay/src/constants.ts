// Fixed values for the relay. Protocol limits come from the shared pairing module.
export { RELAY_API_PREFIX, RELAY_LIMITS } from "../../../packages/pairing/src/constants.ts";

export const RELAY_NAME = "sikrets-relay";
export const AWS_REGION = "us-east-1";

export const ENV = {
  /** DynamoDB table holding messages; unset means in-memory (local dev and tests). */
  table: "RELAY_TABLE",
  port: "PORT",
} as const;

export const LOCAL_PORT = 8787;
/** Largest request body accepted, a little over the biggest blob. */
export const MAX_BODY_BYTES = 40_000;
