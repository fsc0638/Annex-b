import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Annex B — 晨翔航勤合約與招商部",
  description: "AI 辦公室：航空地勤合約與招商部門生成式智能體模擬系統",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
