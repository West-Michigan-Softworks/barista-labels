export const printerDots = (um: number, dotsPerMm: number) =>
  Math.round((um * dotsPerMm) / 1000);

export type BarcodeOptions = {
  bcid: string;
  text: string;
  scale: number;
  height: number;
  paddingwidth: number;
  paddingheight: number;
  includetext: boolean;
  backgroundcolor: string;
};

/** Both renderers fit the same unscaled symbol before enlarging whole modules. */
export async function fitBarcode<T>(
  symbology: string,
  text: string,
  width: number,
  height: number,
  render: (options: BarcodeOptions) => Promise<{ image: T; width: number; height: number }>,
) {
  if (!["code128", "gs1-128", "code39", "ean13", "upca", "qrcode", "datamatrix"].includes(symbology))
    throw new Error("Unsupported barcode symbology.");
  const is2D = ["qrcode", "datamatrix"].includes(symbology);
  const paddingwidth = is2D ? 4 : 10;
  const paddingheight = is2D ? 4 : 0;
  const options: BarcodeOptions = {
    bcid: symbology, text, scale: 1, height: 1, paddingwidth, paddingheight,
    includetext: false, backgroundcolor: "FFFFFF",
  };
  let base = await render(options);
  let scale = Math.floor(Math.min(width / base.width, height / base.height));
  if (!is2D && scale >= 1) {
    base = await render({
      ...options,
      height: Math.max(1, ((Math.floor(height / scale) - 2 * paddingheight - 1) * 25.4) / 72),
    });
    if (base.width * scale > width || base.height * scale > height) scale = 0;
  }
  if (scale < 1)
    throw new Error("Barcode does not fit; enlarge its box to preserve modules and quiet zones.");
  const fittedWidth = base.width * scale;
  // Keep placement on whole printer dots; odd spare widths differ by one dot.
  const offsetX = Math.floor((width - fittedWidth) / 2);
  return { image: base.image, width: fittedWidth, height: base.height * scale, offsetX };
}
