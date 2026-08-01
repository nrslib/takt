interface FindingStorageResource {
  close(): void;
}

const resources = new Set<FindingStorageResource>();

export function registerTestFindingStorage(resource: FindingStorageResource): void {
  resources.add(resource);
}

export function cleanupTestFindingStorage(): void {
  for (const resource of resources) {
    resource.close();
  }
  resources.clear();
}
