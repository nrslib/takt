export function hasOwnFacetPool(
  facetPools: object | undefined,
  poolName: string,
): boolean {
  return facetPools !== undefined && Object.hasOwn(facetPools, poolName);
}
