/**
 * Downscale + JPEG-compress an image file to a small data-URL. Site-progress
 * photos come off phone cameras at 3–8 MB; stored raw they would exhaust the
 * ~5 MB localStorage quota after a handful of updates (db.ts already has to
 * toast-and-abort on quota errors). ~1000px @ q0.7 keeps a photo readable on
 * any dashboard at roughly 80–150 KB.
 */
export function compressImage(file: File, maxDim = 1000, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas not supported')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
    img.src = url;
  });
}
