// Served straight out of public/ — no import, so SSR and the production build
// both resolve it to the same static path.
const logoUrl = "/scheduling-pilot-logo.png";

export const APP_NAME = "Scheduling Pilot";
export const APP_TAGLINE = "Let the pilot do the work — enjoy the ride";

/**
 * The full lockup: SP mark, wordmark and tagline. It is a wide 3:1 image, so
 * drive it from its height (`h-9`, `h-10`) and let the width follow.
 */
/*
 * The artwork is navy lettering on a transparent PNG, so on a dark background it
 * all but vanishes. In night mode it sits on a light plate instead — the brand
 * colours are the point of a logo, and no filter lightens the navy without
 * washing out the blue beside it.
 */
const NIGHT_PLATE = "dark:rounded-lg dark:bg-white dark:px-2 dark:py-1";

export function BrandLogo({ className = "h-9" }: { className?: string }) {
  return <img src={logoUrl} alt={APP_NAME} className={`w-auto ${NIGHT_PLATE} ${className}`} />;
}

// The SP mark's bounding box inside the artwork, in the PNG's own pixels.
// Cropping in CSS keeps one asset on disk instead of a second, near-identical file.
const ART = { w: 2172, h: 724 };
const MARK = { x: 130, y: 110, w: 620, h: 565 };

/**
 * Just the SP mark, in a square box — for the collapsed sidebar rail and
 * anywhere else too narrow for the wordmark.
 */
export function BrandMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const scale = size / MARK.w;
  return (
    <div
      role="img"
      aria-label={APP_NAME}
      className={`shrink-0 bg-no-repeat dark:rounded-md dark:bg-white ${className}`}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${logoUrl})`,
        backgroundSize: `${ART.w * scale}px ${ART.h * scale}px`,
        backgroundPosition: `${-MARK.x * scale}px ${-MARK.y * scale + (size - MARK.h * scale) / 2}px`,
      }}
    />
  );
}
