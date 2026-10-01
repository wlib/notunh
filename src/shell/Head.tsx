/** @jsxImportSource bruh/server */

/** The <head> every page shares, around its own title, description, and entry script */
export const Head = ({ title, description, script }: { title: string, description: string, script: string }) =>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />

    <title>{title}</title>
    <meta name="description" content={description} />

    <meta name="theme-color" content="#fcfaf7" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101317" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon-180.png" />

    <script type="module" src={script} />
  </head>
