"use client";

import { Sidebar } from "./sidebar";
import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { QueryProvider } from "@/components/providers/query-provider";

interface AdminLayoutClientProps {
  children: ReactNode;
  user: {
    name: string;
    email: string | null;
    role: string;
  };
}

export function AdminLayoutClient({ children, user }: AdminLayoutClientProps) {
  const pathname = usePathname();

  if (pathname === "/admin/login") {
    return <>{children}</>;
  }

  return (
    <QueryProvider>
      <div className="min-h-screen bg-slate-50">
        <Sidebar user={user} />
        <main className="lg:ml-64 min-h-screen">{children}</main>
      </div>
    </QueryProvider>
  );
}
