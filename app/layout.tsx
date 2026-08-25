import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Digital You — Create your 3D avatar',
  description:
    'Turn a few photos into a realistic, rotatable 3D avatar. On-device silhouette reconstruction with optional neural photogrammetry.',
  applicationName: 'Digital You',
  appleWebApp: {
    capable: true,
    title: 'Digital You',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#09090B',
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="bg-ink-950">
      <body className="min-h-dvh bg-ink-950 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
