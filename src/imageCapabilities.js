const ROOT_CAPABLE_TAGS = new Set(['google_apis', 'default', 'aosp_atd', 'google_atd']);
const CAPABILITY_ORDER = {
  'root-capable': 0,
  'magisk-required': 1,
  unknown: 2,
};

export function classifySystemImage(packageId) {
  const tag = String(packageId || '').split(';')[2];
  if (tag === 'google_apis_playstore') return 'magisk-required';
  if (ROOT_CAPABLE_TAGS.has(tag)) return 'root-capable';
  return 'unknown';
}

export function sortImagesForMitm(images) {
  return images
    .map((image, index) => ({ image, index, capability: classifySystemImage(image.package) }))
    .sort((left, right) => {
      const priority = CAPABILITY_ORDER[left.capability] - CAPABILITY_ORDER[right.capability];
      return priority || left.index - right.index;
    })
    .map(({ image }) => image);
}

export function formatMitmCapabilityLabel(capability) {
  if (capability === 'root-capable') return 'MITM: полностью автоматически';
  if (capability === 'magisk-required') return 'MITM: требуется Magisk';
  return 'MITM: возможности неизвестны';
}
