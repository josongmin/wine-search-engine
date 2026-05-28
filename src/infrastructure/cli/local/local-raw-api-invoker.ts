import { CliError } from '../../../application/cli/command/cli-error.js';
import type {
  OpenApiDocumentResult,
  RawApiCallInput,
  RawApiCallResult,
} from '../../../application/cli/dto/raw-api.dto.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type { RawApiInvokerPort } from '../../../application/cli/port/raw-api-invoker.port.js';
import { buildHttpRouteContractOpenApiBridge } from '../../../interface/http/routes/http-route-contract-openapi.js';

export class LocalRawApiInvoker implements RawApiInvokerPort {
  call(_input: RawApiCallInput, _options: CliFacadeRequestOptions): Promise<RawApiCallResult> {
    // Usage error (exit 2): the user picked an inapplicable target, not a
    // runtime failure. Surfaces as `EXIT_USAGE` via `CliError.usage` so scripts
    // can distinguish "wrong invocation" from "remote call failed" (exit 4).
    return Promise.reject(
      CliError.usage(
        'Local api call is unsupported. Use typed commands for local execution or switch to --target remote.',
      ),
    );
  }

  openApi(_options: CliFacadeRequestOptions): Promise<OpenApiDocumentResult> {
    return Promise.resolve({
      path: '/openapi.json',
      document: buildHttpRouteContractOpenApiBridge(),
    });
  }
}
