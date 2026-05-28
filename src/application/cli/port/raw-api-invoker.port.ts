import type {
  OpenApiDocumentResult,
  RawApiCallInput,
  RawApiCallResult,
} from '../dto/raw-api.dto.js';
import type { CliFacadeRequestOptions } from './facade-request-options.port.js';

export interface RawApiInvokerPort {
  call(input: RawApiCallInput, options: CliFacadeRequestOptions): Promise<RawApiCallResult>;
  openApi(options: CliFacadeRequestOptions): Promise<OpenApiDocumentResult>;
}
