import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Example Review Board",
  description: "Interactive low-fidelity review board for a fictional sample project.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
