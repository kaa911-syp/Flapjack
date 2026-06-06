import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flapjack — the open-source AI cofounder",
  description:
    "Open-source, self-hosted autonomous AI agent org that runs on a mixture of models and lives in your team chat. Bring your own keys.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

