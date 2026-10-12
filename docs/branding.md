# Barista Labels branding

The identity pairs the existing muted blue (#2e668a) and slate (#263444) palette with a white folded label and barcode mark. Use the banner for documentation and the square mark for application identity. Barcode artwork is decorative and is not a scannable label.

## Assets

All PNGs are in `public/branding`. `barista-banner.png` is the README banner; `barista-icon.png` is the full-resolution transparent master. Sized exports are named `barista-icon-{size}.png` (16, 32, 64, 180, 192, 512). `public/favicon.ico` bundles 16, 32 and 48 pixel PNG entries. Vite copies these public assets into the production build.

## Generation

The original banner and icon concept were created with the built-in image generation tool. The current icon source is the user-edited `public/branding/barista-logo.svg`. All icon PNGs (including the 1254 pixel master) and the ICO container were exported from that SVG with Sharp, preserving transparency. The banner remains the original generated artwork.

### Banner prompt

Use case: logo-brand. Asset type: wide README branding banner for Barista Labels, a professional label design and Zebra barcode printing application. Create a polished wide 3:1 horizontal brand illustration. Cool off-white background, deep slate navy #263444 and muted blue #2e668a with pale blue accents. Left area: exact large text "Barista Labels", smaller exact text "Design. Publish. Print." in clean contemporary sans serif. Right area: elegant dimensional paper label with folded upper-right corner, bold barcode stripes, fine ruler/grid motifs, and one subtle espresso cup silhouette to nod to the name. Restrained enterprise software identity, crisp paper geometry, plenty of whitespace. Not a screenshot, no third-party logos, no additional text. Output one finished banner.

### Icon prompt

Use case: logo-brand. Asset type: square app icon for Barista Labels, used as favicon and 23px header icon. Create ONE extremely clean flat icon: muted blue #2e668a rounded square, centered white paper label silhouette with folded upper-right corner and four bold blue vertical barcode stripes in its lower half. Strong simple geometry, readable at 16px, balanced padding, no text or letters, no shadows, no gradients, no coffee cup, no extra objects, no mockup. Square composition. Transparent outside the rounded blue square. Output a single icon, not a sheet.

