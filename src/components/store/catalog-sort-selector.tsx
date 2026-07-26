"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CatalogSortSelectorProps {
  currentSort?: string;
}

export function CatalogSortSelector({ currentSort }: CatalogSortSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleValueChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    
    if (value === "recientes") {
      if (params.has("buscar")) {
        params.set("ordenar", "recientes");
      } else {
        params.delete("ordenar");
      }
    } else {
      params.set("ordenar", value);
    }

    const query = params.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    router.push(url);
  };

  return (
    <Select value={currentSort || "recientes"} onValueChange={handleValueChange}>
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="recientes">Más recientes</SelectItem>
        <SelectItem value="nombre-asc">Nombre (A-Z)</SelectItem>
        <SelectItem value="nombre-desc">Nombre (Z-A)</SelectItem>
        <SelectItem value="precio-asc">Precio (menor)</SelectItem>
        <SelectItem value="precio-desc">Precio (mayor)</SelectItem>
      </SelectContent>
    </Select>
  );
}
