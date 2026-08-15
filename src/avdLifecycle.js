export function createAvdWithMetadata({ name, systemImagePackage, deviceId }, dependencies) {
  dependencies.create({ name, systemImagePackage, deviceId });
  try {
    dependencies.saveMetadata(name, { systemImagePackage });
    return { created: true, metadataWarning: null };
  } catch (error) {
    return { created: true, metadataWarning: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function clearDeletedAvdMetadata(name, dependencies) {
  const errors = [];
  for (const [kind, clear] of [
    ['launch-defaults', dependencies.clearLaunchDefaults],
    ['avd-settings', dependencies.clearAvdSettings],
  ]) {
    try {
      clear(name);
    } catch (error) {
      errors.push({ kind, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return errors;
}
