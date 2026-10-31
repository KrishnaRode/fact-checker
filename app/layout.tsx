import type { Metadata, Viewport } from "next";
import { appConfig } from "@/app.config";
import "./globals.css";

export const metadata: Metadata = {
  title: `${appConfig.name} — ${appConfig.hero}`,
  description: appConfig.description,
  applicationName: appConfig.name,
  authors: [{ name: appConfig.owner }],
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#05060a",
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
