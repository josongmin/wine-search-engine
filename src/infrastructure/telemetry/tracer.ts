import { trace, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = 'wine-search-engine';
const SERVICE_VERSION = '1.0.0';

/**
 * Returns a named tracer for the wine-search-engine service.
 *
 * Must be called after {@link initTelemetry} to get a functional tracer;
 * before init, calls return a no-op tracer.
 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}

/**
 * Bootstraps the OpenTelemetry NodeSDK with service resource attributes
 * and starts the SDK so traces are collected.
 *
 * Should be called once at application startup, before any requests are served.
 */
export function initTelemetry(): NodeSDK {
  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
  });

  sdk.start();

  return sdk;
}
