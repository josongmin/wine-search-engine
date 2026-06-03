import { DeclaredHttpRouteContractCatalog, computeHttpContractCatalogFingerprint } from '../src/interface/http/routes/http-route-contract-catalog.js';
console.log('COUNT=' + DeclaredHttpRouteContractCatalog.length);
console.log('FP=' + computeHttpContractCatalogFingerprint(DeclaredHttpRouteContractCatalog));
