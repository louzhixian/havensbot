import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: "arkcore",
  },
});

/**
 * Create a child logger with additional context
 */
export const createLogger = (context: Record<string, any>) => {
  return logger.child(context);
};

/**
 * Helper to create operation-scoped logger
 */
export const createOperationLogger = (operation: string, metadata?: Record<string, any>) => {
  return createLogger({ operation, ...metadata });
};
