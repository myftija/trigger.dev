import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import {
  AnyValue,
  ExportLogsServiceRequest,
  ExportLogsServiceResponse,
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
  KeyValue,
  ResourceLogs,
  ResourceSpans,
  SeverityNumber,
  Span,
  Span_Event,
  Span_Link,
  Span_SpanKind,
  Status_StatusCode,
} from "@trigger.dev/otlp-importer";
import {
  CreatableEventKind,
  CreatableEventStatus,
  EventRepository,
  eventRepository,
  type CreatableEvent,
  CreatableEventEnvironmentType,
} from "./eventRepository.server";
import { logger } from "~/services/logger.server";
import { trace, Tracer } from "@opentelemetry/api";
import { startSpan } from "./tracing.server";
import { enrichCreatableEvents } from "./utils/enrichCreatableEvents.server";

export type OTLPExporterConfig = {
  batchSize: number;
  batchInterval: number;
};

class OTLPExporter {
  private _tracer: Tracer;

  constructor(
    private readonly _eventRepository: EventRepository,
    private readonly _verbose: boolean
  ) {
    this._tracer = trace.getTracer("otlp-exporter");
  }

  async exportTraces(
    request: ExportTraceServiceRequest,
    immediate: boolean = false
  ): Promise<ExportTraceServiceResponse> {
    return await startSpan(this._tracer, "exportTraces", async (span) => {
      this.#logExportTracesVerbose(request);

      const events = this.#filterResourceSpans(request.resourceSpans).flatMap((resourceSpan) => {
        return convertSpansToCreateableEvents(resourceSpan);
      });

      const enrichedEvents = enrichCreatableEvents(events);

      this.#logEventsVerbose(enrichedEvents, "exportTraces");

      span.setAttribute("event_count", enrichedEvents.length);

      if (immediate) {
        await this._eventRepository.insertManyImmediate(enrichedEvents);
      } else {
        await this._eventRepository.insertMany(enrichedEvents);
      }

      return ExportTraceServiceResponse.create();
    });
  }

  async exportLogs(
    request: ExportLogsServiceRequest,
    immediate: boolean = false
  ): Promise<ExportLogsServiceResponse> {
    return await startSpan(this._tracer, "exportLogs", async (span) => {
      this.#logExportLogsVerbose(request);

      const events = this.#filterResourceLogs(request.resourceLogs).flatMap((resourceLog) => {
        return convertLogsToCreateableEvents(resourceLog);
      });

      const enrichedEvents = enrichCreatableEvents(events);

      this.#logEventsVerbose(enrichedEvents, "exportLogs");

      span.setAttribute("event_count", enrichedEvents.length);

      if (immediate) {
        await this._eventRepository.insertManyImmediate(enrichedEvents);
      } else {
        await this._eventRepository.insertMany(enrichedEvents);
      }

      return ExportLogsServiceResponse.create();
    });
  }

  #logEventsVerbose(events: CreatableEvent[], prefix: string) {
    if (!this._verbose) return;

    events.forEach((event) => {
      logger.debug(`Exporting ${prefix} event`, { event });
    });
  }

  #logExportTracesVerbose(request: ExportTraceServiceRequest) {
    if (!this._verbose) return;

    logger.debug("Exporting traces", {
      resourceSpans: request.resourceSpans.length,
      totalSpans: request.resourceSpans.reduce(
        (acc, resourceSpan) => acc + resourceSpan.scopeSpans.length,
        0
      ),
    });
  }

  #logExportLogsVerbose(request: ExportLogsServiceRequest) {
    if (!this._verbose) return;

    logger.debug("Exporting logs", {
      resourceLogs: request.resourceLogs.length,
      totalLogs: request.resourceLogs.reduce(
        (acc, resourceLog) =>
          acc +
          resourceLog.scopeLogs.reduce((acc, scopeLog) => acc + scopeLog.logRecords.length, 0),
        0
      ),
    });
  }

  #filterResourceSpans(
    resourceSpans: ExportTraceServiceRequest["resourceSpans"]
  ): ExportTraceServiceRequest["resourceSpans"] {
    return resourceSpans.filter((resourceSpan) => {
      const triggerAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      const executionEnvironmentAttribute = resourceSpan.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.EXECUTION_ENVIRONMENT
      );

      if (!triggerAttribute && !executionEnvironmentAttribute) {
        logger.debug("Skipping resource span without trigger attribute", {
          attributes: resourceSpan.resource?.attributes,
          spans: resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
        });

        return true; // go ahead and let this resource span through
      }

      const executionEnvironment = isStringValue(executionEnvironmentAttribute?.value)
        ? executionEnvironmentAttribute.value.stringValue
        : undefined;

      if (executionEnvironment === "trigger") {
        return true; // go ahead and let this resource span through
      }

      return isBoolValue(triggerAttribute?.value) ? triggerAttribute.value.boolValue : false;
    });
  }

  #filterResourceLogs(
    resourceLogs: ExportLogsServiceRequest["resourceLogs"]
  ): ExportLogsServiceRequest["resourceLogs"] {
    return resourceLogs.filter((resourceLog) => {
      const attribute = resourceLog.resource?.attributes.find(
        (attribute) => attribute.key === SemanticInternalAttributes.TRIGGER
      );

      if (!attribute) return false;

      return isBoolValue(attribute.value) ? attribute.value.boolValue : false;
    });
  }
}

function convertLogsToCreateableEvents(resourceLog: ResourceLogs): Array<CreatableEvent> {
  const resourceAttributes = resourceLog.resource?.attributes ?? [];

  const resourceProperties = extractResourceProperties(resourceAttributes);

  return resourceLog.scopeLogs.flatMap((scopeLog) => {
    return scopeLog.logRecords
      .map((log) => {
        const logLevel = logLevelToEventLevel(log.severityNumber);

        if (!log.traceId || !log.spanId) {
          return;
        }

        return {
          traceId: binaryToHex(log.traceId),
          spanId: eventRepository.generateSpanId(),
          parentId: binaryToHex(log.spanId),
          message: isStringValue(log.body)
            ? log.body.stringValue.slice(0, 4096)
            : `${log.severityText} log`,
          isPartial: false,
          kind: "INTERNAL" as const,
          level: logLevelToEventLevel(log.severityNumber),
          isError: logLevel === "ERROR",
          status: logLevelToEventStatus(log.severityNumber),
          startTime: log.timeUnixNano,
          properties: {
            ...convertKeyValueItemsToMap(log.attributes ?? [], [
              SemanticInternalAttributes.SPAN_ID,
              SemanticInternalAttributes.SPAN_PARTIAL,
            ]),
            ...convertKeyValueItemsToMap(
              resourceAttributes,
              [SemanticInternalAttributes.TRIGGER],
              SemanticInternalAttributes.METADATA
            ),
          },
          style: convertKeyValueItemsToMap(
            pickAttributes(log.attributes ?? [], SemanticInternalAttributes.STYLE),
            []
          ),
          output: detectPrimitiveValue(
            convertKeyValueItemsToMap(
              pickAttributes(log.attributes ?? [], SemanticInternalAttributes.OUTPUT),
              []
            ),
            SemanticInternalAttributes.OUTPUT
          ),
          payload: detectPrimitiveValue(
            convertKeyValueItemsToMap(
              pickAttributes(log.attributes ?? [], SemanticInternalAttributes.PAYLOAD),
              []
            ),
            SemanticInternalAttributes.PAYLOAD
          ),
          ...resourceProperties,
          attemptId:
            extractStringAttribute(
              log.attributes ?? [],
              [SemanticInternalAttributes.METADATA, SemanticInternalAttributes.ATTEMPT_ID].join(".")
            ) ?? resourceProperties.attemptId,
          attemptNumber:
            extractNumberAttribute(
              log.attributes ?? [],
              [SemanticInternalAttributes.METADATA, SemanticInternalAttributes.ATTEMPT_NUMBER].join(
                "."
              )
            ) ?? resourceProperties.attemptNumber,
        };
      })
      .filter(Boolean);
  });
}

function convertSpansToCreateableEvents(resourceSpan: ResourceSpans): Array<CreatableEvent> {
  const resourceAttributes = resourceSpan.resource?.attributes ?? [];

  const resourceProperties = extractResourceProperties(resourceAttributes);

  return resourceSpan.scopeSpans.flatMap((scopeSpan) => {
    return scopeSpan.spans
      .map((span) => {
        const isPartial = isPartialSpan(span);

        if (!span.traceId || !span.spanId) {
          return;
        }

        return {
          traceId: binaryToHex(span.traceId),
          spanId: isPartial
            ? extractStringAttribute(
                span?.attributes ?? [],
                SemanticInternalAttributes.SPAN_ID,
                binaryToHex(span.spanId)
              )
            : binaryToHex(span.spanId),
          parentId: binaryToHex(span.parentSpanId),
          message: span.name,
          isPartial,
          isError: span.status?.code === Status_StatusCode.ERROR,
          kind: spanKindToEventKind(span.kind),
          level: "TRACE" as const,
          status: spanStatusToEventStatus(span.status),
          startTime: span.startTimeUnixNano,
          links: spanLinksToEventLinks(span.links ?? []),
          events: spanEventsToEventEvents(span.events ?? []),
          duration: span.endTimeUnixNano - span.startTimeUnixNano,
          properties: {
            ...convertKeyValueItemsToMap(span.attributes ?? [], [
              SemanticInternalAttributes.SPAN_ID,
              SemanticInternalAttributes.SPAN_PARTIAL,
            ]),
            ...convertKeyValueItemsToMap(
              resourceAttributes,
              [SemanticInternalAttributes.TRIGGER],
              SemanticInternalAttributes.METADATA
            ),
          },
          style: convertKeyValueItemsToMap(
            pickAttributes(span.attributes ?? [], SemanticInternalAttributes.STYLE),
            []
          ),
          output: detectPrimitiveValue(
            convertKeyValueItemsToMap(
              pickAttributes(span.attributes ?? [], SemanticInternalAttributes.OUTPUT),
              []
            ),
            SemanticInternalAttributes.OUTPUT
          ),
          outputType: pickAttributeStringValue(
            span.attributes ?? [],
            SemanticInternalAttributes.OUTPUT_TYPE
          ),
          payload: detectPrimitiveValue(
            convertKeyValueItemsToMap(
              pickAttributes(span.attributes ?? [], SemanticInternalAttributes.PAYLOAD),
              []
            ),
            SemanticInternalAttributes.PAYLOAD
          ),
          payloadType:
            pickAttributeStringValue(
              span.attributes ?? [],
              SemanticInternalAttributes.PAYLOAD_TYPE
            ) ?? "application/json",
          ...resourceProperties,
          attemptId:
            extractStringAttribute(
              span.attributes ?? [],
              [SemanticInternalAttributes.METADATA, SemanticInternalAttributes.ATTEMPT_ID].join(".")
            ) ?? resourceProperties.attemptId,
          attemptNumber:
            extractNumberAttribute(
              span.attributes ?? [],
              [SemanticInternalAttributes.METADATA, SemanticInternalAttributes.ATTEMPT_NUMBER].join(
                "."
              )
            ) ?? resourceProperties.attemptNumber,
          usageDurationMs:
            extractDoubleAttribute(
              span.attributes ?? [],
              SemanticInternalAttributes.USAGE_DURATION_MS
            ) ??
            extractNumberAttribute(
              span.attributes ?? [],
              SemanticInternalAttributes.USAGE_DURATION_MS
            ),
          usageCostInCents: extractDoubleAttribute(
            span.attributes ?? [],
            SemanticInternalAttributes.USAGE_COST_IN_CENTS
          ),
        };
      })
      .filter(Boolean);
  });
}

function extractResourceProperties(attributes: KeyValue[]) {
  return {
    metadata: convertKeyValueItemsToMap(attributes, [SemanticInternalAttributes.TRIGGER]),
    serviceName: extractStringAttribute(
      attributes,
      SemanticResourceAttributes.SERVICE_NAME,
      "unknown"
    ),
    serviceNamespace: extractStringAttribute(
      attributes,
      SemanticResourceAttributes.SERVICE_NAMESPACE,
      "unknown"
    ),
    environmentId: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.ENVIRONMENT_ID,
      "unknown"
    ),
    environmentType: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.ENVIRONMENT_TYPE,
      "unknown"
    ) as CreatableEventEnvironmentType,
    organizationId: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.ORGANIZATION_ID,
      "unknown"
    ),
    projectId: extractStringAttribute(attributes, SemanticInternalAttributes.PROJECT_ID, "unknown"),
    projectRef: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.PROJECT_REF,
      "unknown"
    ),
    runId: extractStringAttribute(attributes, SemanticInternalAttributes.RUN_ID, "unknown"),
    runIsTest: extractBooleanAttribute(attributes, SemanticInternalAttributes.RUN_IS_TEST, false),
    attemptId: extractStringAttribute(attributes, SemanticInternalAttributes.ATTEMPT_ID),
    attemptNumber: extractNumberAttribute(attributes, SemanticInternalAttributes.ATTEMPT_NUMBER),
    taskSlug: extractStringAttribute(attributes, SemanticInternalAttributes.TASK_SLUG, "unknown"),
    taskPath: extractStringAttribute(attributes, SemanticInternalAttributes.TASK_PATH),
    taskExportName: "@deprecated",
    workerId: extractStringAttribute(attributes, SemanticInternalAttributes.WORKER_ID),
    workerVersion: extractStringAttribute(attributes, SemanticInternalAttributes.WORKER_VERSION),
    queueId: extractStringAttribute(attributes, SemanticInternalAttributes.QUEUE_ID),
    queueName: extractStringAttribute(attributes, SemanticInternalAttributes.QUEUE_NAME),
    batchId: extractStringAttribute(attributes, SemanticInternalAttributes.BATCH_ID),
    idempotencyKey: extractStringAttribute(attributes, SemanticInternalAttributes.IDEMPOTENCY_KEY),
    machinePreset: extractStringAttribute(
      attributes,
      SemanticInternalAttributes.MACHINE_PRESET_NAME
    ),
    machinePresetCpu:
      extractDoubleAttribute(attributes, SemanticInternalAttributes.MACHINE_PRESET_CPU) ??
      extractNumberAttribute(attributes, SemanticInternalAttributes.MACHINE_PRESET_CPU),
    machinePresetMemory:
      extractDoubleAttribute(attributes, SemanticInternalAttributes.MACHINE_PRESET_MEMORY) ??
      extractNumberAttribute(attributes, SemanticInternalAttributes.MACHINE_PRESET_MEMORY),
    machinePresetCentsPerMs: extractDoubleAttribute(
      attributes,
      SemanticInternalAttributes.MACHINE_PRESET_CENTS_PER_MS
    ),
  };
}

function pickAttributes(attributes: KeyValue[], prefix: string): KeyValue[] {
  return attributes
    .filter((attribute) => attribute.key.startsWith(prefix))
    .map((attribute) => {
      return {
        key: attribute.key.replace(`${prefix}.`, ""),
        value: attribute.value,
      };
    });
}

function pickAttributeStringValue(attributes: KeyValue[], key: string): string | undefined {
  const attribute = attributes.find((attribute) => attribute.key === key);

  if (!attribute) return undefined;

  return isStringValue(attribute.value) ? attribute.value.stringValue : undefined;
}

function convertKeyValueItemsToMap(
  attributes: KeyValue[],
  filteredKeys: string[] = [],
  prefix?: string
): Record<string, string | number | boolean | undefined> | undefined {
  if (!attributes) return;
  if (!attributes.length) return;

  const filteredAttributes = attributes.filter(
    (attribute) => !filteredKeys.includes(attribute.key)
  );

  if (!filteredAttributes.length) return;

  const result = filteredAttributes.reduce(
    (map: Record<string, string | number | boolean | undefined>, attribute) => {
      map[`${prefix ? `${prefix}.` : ""}${attribute.key}`] = isStringValue(attribute.value)
        ? attribute.value.stringValue
        : isIntValue(attribute.value)
        ? Number(attribute.value.intValue)
        : isDoubleValue(attribute.value)
        ? attribute.value.doubleValue
        : isBoolValue(attribute.value)
        ? attribute.value.boolValue
        : isBytesValue(attribute.value)
        ? binaryToHex(attribute.value.bytesValue)
        : undefined;

      return map;
    },
    {}
  );

  return result;
}

function detectPrimitiveValue(
  attributes: Record<string, string | number | boolean | undefined> | undefined,
  sentinel: string
): Record<string, string | number | boolean | undefined> | string | number | boolean | undefined {
  if (!attributes) return undefined;

  if (typeof attributes[sentinel] !== "undefined") {
    return attributes[sentinel];
  }

  return attributes;
}

function spanLinksToEventLinks(links: Span_Link[]): CreatableEvent["links"] {
  return links.map((link) => {
    return {
      traceId: binaryToHex(link.traceId),
      spanId: binaryToHex(link.spanId),
      tracestate: link.traceState,
      properties: convertKeyValueItemsToMap(link.attributes ?? []),
    };
  });
}

function spanEventsToEventEvents(events: Span_Event[]): CreatableEvent["events"] {
  return events.map((event) => {
    return {
      name: event.name,
      time: convertUnixNanoToDate(event.timeUnixNano),
      properties: convertKeyValueItemsToMap(event.attributes ?? []),
    };
  });
}

function spanStatusToEventStatus(status: Span["status"]): CreatableEventStatus {
  if (!status) return "UNSET";

  switch (status.code) {
    case Status_StatusCode.OK: {
      return "OK";
    }
    case Status_StatusCode.ERROR: {
      return "ERROR";
    }
    case Status_StatusCode.UNSET: {
      return "UNSET";
    }
    default: {
      return "UNSET";
    }
  }
}

function spanKindToEventKind(kind: Span["kind"]): CreatableEventKind {
  switch (kind) {
    case Span_SpanKind.CLIENT: {
      return "CLIENT";
    }
    case Span_SpanKind.SERVER: {
      return "SERVER";
    }
    case Span_SpanKind.CONSUMER: {
      return "CONSUMER";
    }
    case Span_SpanKind.PRODUCER: {
      return "PRODUCER";
    }
    default: {
      return "INTERNAL";
    }
  }
}

function logLevelToEventLevel(level: SeverityNumber): CreatableEvent["level"] {
  switch (level) {
    case SeverityNumber.TRACE:
    case SeverityNumber.TRACE2:
    case SeverityNumber.TRACE3:
    case SeverityNumber.TRACE4: {
      return "TRACE";
    }
    case SeverityNumber.DEBUG:
    case SeverityNumber.DEBUG2:
    case SeverityNumber.DEBUG3:
    case SeverityNumber.DEBUG4: {
      return "DEBUG";
    }
    case SeverityNumber.INFO:
    case SeverityNumber.INFO2:
    case SeverityNumber.INFO3:
    case SeverityNumber.INFO4: {
      return "INFO";
    }
    case SeverityNumber.WARN:
    case SeverityNumber.WARN2:
    case SeverityNumber.WARN3:
    case SeverityNumber.WARN4: {
      return "WARN";
    }
    case SeverityNumber.ERROR:
    case SeverityNumber.ERROR2:
    case SeverityNumber.ERROR3:
    case SeverityNumber.ERROR4: {
      return "ERROR";
    }
    case SeverityNumber.FATAL:
    case SeverityNumber.FATAL2:
    case SeverityNumber.FATAL3:
    case SeverityNumber.FATAL4: {
      return "ERROR";
    }
    default: {
      return "INFO";
    }
  }
}

function logLevelToEventStatus(level: SeverityNumber): CreatableEventStatus {
  switch (level) {
    case SeverityNumber.TRACE:
    case SeverityNumber.TRACE2:
    case SeverityNumber.TRACE3:
    case SeverityNumber.TRACE4: {
      return "OK";
    }
    case SeverityNumber.DEBUG:
    case SeverityNumber.DEBUG2:
    case SeverityNumber.DEBUG3:
    case SeverityNumber.DEBUG4: {
      return "OK";
    }
    case SeverityNumber.INFO:
    case SeverityNumber.INFO2:
    case SeverityNumber.INFO3:
    case SeverityNumber.INFO4: {
      return "OK";
    }
    case SeverityNumber.WARN:
    case SeverityNumber.WARN2:
    case SeverityNumber.WARN3:
    case SeverityNumber.WARN4: {
      return "OK";
    }
    case SeverityNumber.ERROR:
    case SeverityNumber.ERROR2:
    case SeverityNumber.ERROR3:
    case SeverityNumber.ERROR4: {
      return "ERROR";
    }
    case SeverityNumber.FATAL:
    case SeverityNumber.FATAL2:
    case SeverityNumber.FATAL3:
    case SeverityNumber.FATAL4: {
      return "ERROR";
    }
    default: {
      return "OK";
    }
  }
}

function convertUnixNanoToDate(unixNano: bigint | number): Date {
  return new Date(Number(BigInt(unixNano) / BigInt(1_000_000)));
}

function extractStringAttribute(attributes: KeyValue[], name: string): string | undefined;
function extractStringAttribute(attributes: KeyValue[], name: string, fallback: string): string;
function extractStringAttribute(
  attributes: KeyValue[],
  name: string,
  fallback?: string
): string | undefined {
  const attribute = attributes.find((attribute) => attribute.key === name);

  if (!attribute) return fallback;

  return isStringValue(attribute?.value) ? attribute.value.stringValue : fallback;
}

function extractNumberAttribute(attributes: KeyValue[], name: string): number | undefined;
function extractNumberAttribute(attributes: KeyValue[], name: string, fallback: number): number;
function extractNumberAttribute(
  attributes: KeyValue[],
  name: string,
  fallback?: number
): number | undefined {
  const attribute = attributes.find((attribute) => attribute.key === name);

  if (!attribute) return fallback;

  return isIntValue(attribute?.value) ? Number(attribute.value.intValue) : fallback;
}

function extractDoubleAttribute(attributes: KeyValue[], name: string): number | undefined;
function extractDoubleAttribute(attributes: KeyValue[], name: string, fallback: number): number;
function extractDoubleAttribute(
  attributes: KeyValue[],
  name: string,
  fallback?: number
): number | undefined {
  const attribute = attributes.find((attribute) => attribute.key === name);

  if (!attribute) return fallback;

  return isDoubleValue(attribute?.value) ? Number(attribute.value.doubleValue) : fallback;
}

function extractBooleanAttribute(attributes: KeyValue[], name: string): boolean | undefined;
function extractBooleanAttribute(attributes: KeyValue[], name: string, fallback: boolean): boolean;
function extractBooleanAttribute(
  attributes: KeyValue[],
  name: string,
  fallback?: boolean
): boolean | undefined {
  const attribute = attributes.find((attribute) => attribute.key === name);

  if (!attribute) return fallback;

  return isBoolValue(attribute?.value) ? attribute.value.boolValue : fallback;
}

function isPartialSpan(span: Span): boolean {
  if (!span.attributes) return false;

  const attribute = span.attributes.find(
    (attribute) => attribute.key === SemanticInternalAttributes.SPAN_PARTIAL
  );

  if (!attribute) return false;

  return isBoolValue(attribute.value) ? attribute.value.boolValue : false;
}

function isBoolValue(value: AnyValue | undefined): value is { boolValue: boolean } {
  if (!value) return false;

  return typeof value.boolValue === "boolean";
}

function isStringValue(value: AnyValue | undefined): value is { stringValue: string } {
  if (!value) return false;

  return typeof value.stringValue === "string";
}

function isIntValue(value: AnyValue | undefined): value is { intValue: bigint } {
  if (!value) return false;

  return typeof value.intValue === "number" || typeof value.intValue === "bigint";
}

function isDoubleValue(value: AnyValue | undefined): value is { doubleValue: number } {
  if (!value) return false;

  return typeof value.doubleValue === "number";
}

function isBytesValue(value: AnyValue | undefined): value is { bytesValue: Buffer } {
  if (!value) return false;

  return Buffer.isBuffer(value.bytesValue);
}

function binaryToHex(buffer: Buffer | string): string;
function binaryToHex(buffer: Buffer | string | undefined): string | undefined;
function binaryToHex(buffer: Buffer | string | undefined): string | undefined {
  if (!buffer) return undefined;
  if (typeof buffer === "string") return buffer;

  return Buffer.from(Array.from(buffer)).toString("hex");
}

export const otlpExporter = new OTLPExporter(
  eventRepository,
  process.env.OTLP_EXPORTER_VERBOSE === "1"
);
