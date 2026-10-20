import type { SVGProps } from "react";

type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  "width" | "height" | "children"
> & { size?: number };

// Compact drawings have wider gaps and fewer details than the 24-unit artwork.
// Keep these SVGs decorative; their host controls supply labels.

export function LibraryIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-library ${className}`}
    >
      {compact ? (
        <>
          <path
            d="M4 7V4h4v3M8 7V2h4v5"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M2 7h12v7H2zM7 10.5h2" />
        </>
      ) : (
        <>
          <path
            d="M6 9V5h6v4M12 9V3h6v6"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M3 9h18v12H3zM10 15h4" />
        </>
      )}
    </svg>
  );
}

export function UnfiledIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-unfiled ${className}`}
    >
      {compact ? (
        <>
          <path
            d="m6 1 5 1-1 5-5-1z"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M2 9v5h12V9M2 10h3l1 2h4l1-2h3" />
        </>
      ) : (
        <>
          <path
            d="m9 2 7 2-2 7-7-2z"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M3 13v7h18v-7M3 14h5l2 3h4l2-3h5" />
        </>
      )}
    </svg>
  );
}

export function OrganizeIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-organize ${className}`}
    >
      {compact ? (
        <>
          <path
            d="m3 1 4 1-1 4-4-1z"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M10 2h4v4h-4zM2 10h4v4H2zM10 10h4v4h-4z" />
        </>
      ) : (
        <>
          <path
            d="m4 2 6 2-2 6-6-2z"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
        </>
      )}
    </svg>
  );
}

export function ConnectionsIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-connections ${className}`}
    >
      {compact ? (
        <>
          <path d="m6 9-1 1a2.5 2.5 0 0 1-3-4l3-3a2.5 2.5 0 0 1 4 1" />
          <path
            d="m10 7 1-1a2.5 2.5 0 0 1 3 4l-3 3a2.5 2.5 0 0 1-4-1"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="m6 10 4-4" />
        </>
      ) : (
        <>
          <path
            d="m9 14-2 2a4 4 0 0 1-6-5l4-4a4 4 0 0 1 6 0"
            transform="translate(2 0)"
          />
          <path
            d="m13 10 2-2a4 4 0 0 1 6 5l-4 4a4 4 0 0 1-6 0"
            transform="translate(-2 0)"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="m9 15 6-6" />
        </>
      )}
    </svg>
  );
}

export function EvidenceIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-evidence ${className}`}
    >
      {compact ? (
        <>
          <path
            fill="currentColor"
            stroke="none"
            d="M2 3h4v4c0 2-1 3-3 4V9c1-1 2-1 2-2H2zM10 3h4v4c0 2-1 3-3 4V9c1-1 2-1 2-2h-3z"
          />
          <path
            d="M2 14h12"
            stroke="var(--icon-accent,currentColor)"
            strokeWidth="2"
          />
        </>
      ) : (
        <>
          <path
            fill="currentColor"
            stroke="none"
            d="M4 4h6v6c0 3-2 5-5 6v-2c2-1 3-2 3-4H4zM14 4h6v6c0 3-2 5-5 6v-2c2-1 3-2 3-4h-4z"
          />
          <path
            d="M4 20h16"
            stroke="var(--icon-accent,currentColor)"
            strokeWidth="3"
          />
        </>
      )}
    </svg>
  );
}

export function VersionsIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-versions ${className}`}
    >
      {compact ? (
        <>
          <path
            d="M2 10V2h8M4 12V4h8"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M6 6h8v6l-2 2H6zM10 14v-4h4" />
        </>
      ) : (
        <>
          <path
            d="M3 16V3h12M6 19V6h12"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M9 9h12v9l-3 3H9zM16 21v-5h5" />
        </>
      )}
    </svg>
  );
}

export function ReviewIcon({ size = 20, className = "", ...props }: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-review ${className}`}
    >
      {compact ? (
        <>
          <path d="M2 2h8M2 2v11h3" stroke="var(--icon-accent,currentColor)" />
          <circle cx="10" cy="9" r="3.5" />
          <path d="m12.5 11.5 2.5 2.5" />
        </>
      ) : (
        <>
          <path
            d="m4 3 10 1-1 7M3 8 2 20l7 1M6 7l4 .4"
            stroke="var(--icon-accent,currentColor)"
          />
          <circle cx="15" cy="15" r="5" />
          <path d="m19 19 3 3" />
        </>
      )}
    </svg>
  );
}

export function OverviewIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-overview ${className}`}
    >
      {compact ? (
        <>
          <path d="M2 2h5v12H2z" />
          <path
            d="M10 2h4v4h-4zM10 9h4v5h-4z"
            stroke="var(--icon-accent,currentColor)"
          />
        </>
      ) : (
        <>
          <path d="M3 3h8v18H3z" />
          <path
            d="M15 3h6v6h-6zM15 13h6v8h-6z"
            stroke="var(--icon-accent,currentColor)"
          />
        </>
      )}
    </svg>
  );
}

export function CardsIcon({ size = 20, className = "", ...props }: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-cards ${className}`}
    >
      {compact ? (
        <>
          <path d="m2 3 7-2 2 10" stroke="var(--icon-accent,currentColor)" />
          <path d="M5 4h9v10H5zM8 8h3" />
        </>
      ) : (
        <>
          <path
            d="m4 4 11-2 3 16-5 1"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M7 6h13v15H7zM10 11h7M10 15h4" />
        </>
      )}
    </svg>
  );
}

export function MapIcon({ size = 20, className = "", ...props }: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-map ${className}`}
    >
      {compact ? (
        <>
          <path d="m6 5 5 1M5 7l5 5" />
          <path
            d="m4 1 3 3-3 3-3-3z"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M11 4h4v4h-4zM10 11h4v4h-4z" />
        </>
      ) : (
        <>
          <path d="m9 7 6 1M7 10l8 7" />
          <path
            d="m6 2 5 4-5 5-4-5z"
            stroke="var(--icon-accent,currentColor)"
          />
          <path d="M16 5h6v6h-6zM15 16h6v6h-6z" />
        </>
      )}
    </svg>
  );
}

export function DocumentIcon({
  size = 20,
  className = "",
  ...props
}: IconProps) {
  const compact = size <= 16;
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox={compact ? "0 0 16 16" : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth={compact ? 1.5 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon app-icon-document ${className}`}
    >
      {compact ? (
        <>
          <path d="M3 2h7l3 3v9H3zM10 2v4h3" />
          <path d="M6 10h4" stroke="var(--icon-accent,currentColor)" />
        </>
      ) : (
        <>
          <path d="M5 3h10l4 4v14H5zM15 3v5h4" />
          <path d="M9 12h6M9 16h4" stroke="var(--icon-accent,currentColor)" />
        </>
      )}
    </svg>
  );
}
