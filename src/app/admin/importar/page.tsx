import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { Header } from "@/components/admin/header";
import { ImportadorCSV } from "@/components/admin/import-csv";
import { BulkImageAssignment } from "@/components/admin/bulk-image-assignment";

export default async function AdminImportPage() {
  const user = await requireAdminUser();
  if (!user) redirect("/admin/login");

  return (
    <>
      <Header
        title="Importador masivo"
        subtitle="Carga productos desde un archivo CSV"
      />
      <ImportadorCSV />
      <BulkImageAssignment />
    </>
  );
}
