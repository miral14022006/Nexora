import { z } from "zod";

const uuid = z.string().uuid("Must be a valid UUID");

export const createMessageSchema = z
  .object({
    type: z.enum(["DIRECT", "GROUP"]),
    recipientId: uuid.optional(),
    groupId: uuid.optional(),
    // Standardized envelope (see ARCHITECTURE.md "Idempotency & Deduplication"):
    //   client_msg_id — client-generated idempotency key (uuid). If omitted the
    //                   server generates one (retries then won't be deduped).
    //   conversation_id — the peer userId (DIRECT) or groupId (GROUP), an alias
    //                   for recipientId/groupId.
    client_msg_id: uuid.optional(),
    conversation_id: uuid.optional(),
    content: z
      .string()
      .min(1, "Content must not be empty")
      .max(4000, "Content must be at most 4000 characters")
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, "Content must not be empty"),
  })
  .refine(
    (data) => data.type === "DIRECT" ? !!data.recipientId || !!data.conversation_id : true,
    { message: "DIRECT messages require a recipientId (or conversation_id)", path: ["recipientId"] }
  )
  .refine(
    (data) => data.type === "DIRECT" ? !data.groupId : true,
    { message: "DIRECT messages must not include a groupId", path: ["groupId"] }
  )
  .refine(
    (data) => data.type === "GROUP" ? !!data.groupId || !!data.conversation_id : true,
    { message: "GROUP messages require a groupId (or conversation_id)", path: ["groupId"] }
  )
  .refine(
    (data) => data.type === "GROUP" ? !data.recipientId : true,
    { message: "GROUP messages must not include a recipientId", path: ["recipientId"] }
  )
  .refine(
    (data) =>
      !data.conversation_id ||
      (data.type === "DIRECT" ? !data.recipientId || data.recipientId === data.conversation_id : true),
    { message: "recipientId must match conversation_id for DIRECT messages", path: ["conversation_id"] }
  )
  .refine(
    (data) =>
      !data.conversation_id ||
      (data.type === "GROUP" ? !data.groupId || data.groupId === data.conversation_id : true),
    { message: "groupId must match conversation_id for GROUP messages", path: ["conversation_id"] }
  );

const cursorPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})_[0-9a-f-]{36}$/;

export const historyQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .optional(),
  cursor: z
    .string()
    .regex(cursorPattern, "cursor must be a nextCursor value returned by the API")
    .optional(),
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    req.query = result.data;
    next();
  };
}

export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    next();
  };
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
