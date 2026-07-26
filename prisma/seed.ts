import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedLogistics } from "./seed-logistics";

const prisma = new PrismaClient();

// Función para generar slug
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function main() {
  console.log("🌱 Iniciando seed de Compusum...");

  // =====================
  // 1. CREAR USUARIO ADMIN
  // =====================
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL;
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
  const adminName = process.env.INITIAL_ADMIN_NAME || "Administrador Compusum";

  const existingAdmin = await prisma.user.findFirst({
    where: { role: "admin" },
  });

  if (adminEmail && adminPassword) {
    const hashedPassword = await bcrypt.hash(adminPassword, 12);
    const admin = await prisma.user.upsert({
      where: { email: adminEmail },
      update: {},
      create: {
        name: adminName,
        email: adminEmail,
        password: hashedPassword,
        role: "admin",
        isActive: true,
      },
    });
    console.log("✅ Usuario admin procesado:", admin.email);
  } else if (existingAdmin) {
    console.log("ℹ️ Usuario admin ya existe en la base de datos:", existingAdmin.email);
  } else {
    console.log("⚠️ No se creó usuario admin inicial. Defina INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD para crearlo.");
  }

  // =====================
  // 2. CREAR CATEGORÍAS Y SUBCATEGORÍAS
  // =====================
  const categoriesData = [
    {
      name: "Escolar",
      icon: "📚",
      description:
        "Todo el material escolar que necesitas para el regreso a clases",
      subcategories: [
        { name: "Crayones y Colores", icon: "🖍️" },
        { name: "Cuadernos y Agendas", icon: "📓" },
        { name: "Plastilinas", icon: "🎨" },
        { name: "Loncheras", icon: "🎒" },
        { name: "Útiles Varios", icon: "✏️" },
      ],
    },
    {
      name: "Oficina",
      icon: "🏢",
      description: "Suministros de oficina para empresas y profesionales",
      subcategories: [
        { name: "Resmas y Papel", icon: "📄" },
        { name: "Archivadores y Carpetas", icon: "📁" },
        { name: "Adhesivos y Cintas", icon: "🔗" },
        { name: "Marcadores y Resaltadores", icon: "🖊️" },
        { name: "Bolígrafos y Lápices", icon: "✒️" },
      ],
    },
    {
      name: "Arte y Manualidades",
      icon: "🎨",
      description: "Materiales artísticos para creativos",
      subcategories: [
        { name: "Acrílicos y Vinilos", icon: "🖌️" },
        { name: "Marcadores Lettering", icon: "✍️" },
        { name: "Papeles Especiales", icon: "📜" },
        { name: "Pinceles y Herramientas", icon: "🔧" },
      ],
    },
    {
      name: "Tecnología y Accesorios",
      icon: "💻",
      description: "Accesorios tecnológicos para tu trabajo y hogar",
      subcategories: [
        { name: "Teclados y Mouse", icon: "⌨️" },
        { name: "Cables y Adaptadores", icon: "🔌" },
        { name: "Pilas y Baterías", icon: "🔋" },
        { name: "Memorias USB", icon: "💾" },
      ],
    },
    {
      name: "Ergonomía y Organización",
      icon: "📐",
      description: "Organiza tu espacio de trabajo",
      subcategories: [
        { name: "Bases para Monitor", icon: "🖥️" },
        { name: "Organizadores de Escritorio", icon: "🗃️" },
      ],
    },
  ];

  for (const catData of categoriesData) {
    const parent = await prisma.category.upsert({
      where: { slug: slugify(catData.name) },
      update: {},
      create: {
        name: catData.name,
        slug: slugify(catData.name),
        description: catData.description,
        icon: catData.icon,
        sortOrder: categoriesData.indexOf(catData),
        isActive: true,
      },
    });

    console.log(`✅ Categoría creada: ${parent.name}`);

    for (const subcat of catData.subcategories) {
      await prisma.category.upsert({
        where: { slug: slugify(subcat.name) },
        update: {},
        create: {
          name: subcat.name,
          slug: slugify(subcat.name),
          icon: subcat.icon,
          parentId: parent.id,
          sortOrder: catData.subcategories.indexOf(subcat),
          isActive: true,
        },
      });
    }
  }

  // =====================
  // 3. CREAR MARCAS
  // =====================
  const brandsData = [
    { name: "Faber-Castell", website: "https://www.faber-castell.com" },
    { name: "Kores", website: "https://www.kores.com" },
    { name: "Legis", website: "https://www.legis.com.co" },
    { name: "Doricolor" },
    { name: "Rapid" },
    { name: "Tintas y Trazos" },
    { name: "Panasonic", website: "https://www.panasonic.com" },
    { name: "Norma" },
    { name: "Pelikan" },
    { name: "Familia" },
    { name: "Bic", website: "https://www.bic.com" },
    { name: "Maped" },
    { name: "Staedtler" },
    { name: "PaperMate" },
    { name: "Pilot" },
  ];

  for (const brandData of brandsData) {
    await prisma.brand.upsert({
      where: { slug: slugify(brandData.name) },
      update: {},
      create: {
        name: brandData.name,
        slug: slugify(brandData.name),
        website: brandData.website || null,
        isActive: true,
        sortOrder: brandsData.indexOf(brandData),
      },
    });
  }
  console.log(`✅ ${brandsData.length} marcas creadas`);

  // =====================
  // 4. CREAR TEMPORADAS
  // =====================
  const currentYear = new Date().getFullYear();

  const seasonsData = [
    {
      name: "Regreso a Clases",
      description: "Todo lo que necesitas para el inicio del año escolar",
      colorHex: "#FF6A00",
      startDate: new Date(currentYear, 0, 1),
      endDate: new Date(currentYear, 2, 31),
    },
    {
      name: "Día del Niño",
      description: "Celebra a los más pequeños con los mejores regalos",
      colorHex: "#E89A00",
      startDate: new Date(currentYear, 3, 1),
      endDate: new Date(currentYear, 3, 30),
    },
    {
      name: "Navidad",
      description: "Artículos especiales para la temporada navideña",
      colorHex: "#C41E3A",
      startDate: new Date(currentYear, 10, 15),
      endDate: new Date(currentYear, 11, 31),
    },
  ];

  for (const seasonData of seasonsData) {
    await prisma.season.upsert({
      where: { slug: slugify(seasonData.name) },
      update: {},
      create: {
        name: seasonData.name,
        slug: slugify(seasonData.name),
        description: seasonData.description,
        colorHex: seasonData.colorHex,
        startDate: seasonData.startDate,
        endDate: seasonData.endDate,
        isActive: true,
      },
    });
  }
  console.log(`✅ ${seasonsData.length} temporadas creadas`);

  // =====================
  // 5. CREAR BANNERS
  // =====================
  const bannersData = [
    {
      title: "Regreso a Clases 2025",
      subtitle: "Todo el material escolar al mejor precio mayorista",
      imageDesktop: "/images/banners/back-to-school.jpg",
      linkUrl: "/catalogo?categoria=escolar",
      linkText: "Ver productos",
      position: "hero",
      isActive: true,
      sortOrder: 0,
    },
    {
      title: "Precios por Volumen",
      subtitle: "Descuentos especiales para compras mayoristas",
      imageDesktop: "/images/banners/wholesale.jpg",
      linkUrl: "/mayoristas",
      linkText: "Más información",
      position: "hero",
      isActive: true,
      sortOrder: 1,
    },
    {
      title: "Marcas Premium",
      subtitle: "Distribuidores autorizados de las mejores marcas",
      imageDesktop: "/images/banners/brands.jpg",
      linkUrl: "/marcas",
      linkText: "Ver marcas",
      position: "promo",
      isActive: true,
      sortOrder: 0,
    },
  ];

  for (const banner of bannersData) {
    const existing = await prisma.banner.findFirst({
      where: { title: banner.title },
    });
    if (!existing) {
      await prisma.banner.create({ data: banner });
    }
  }
  console.log("✅ Banners creados");

  // =====================
  // 6. CREAR CONFIGURACIONES
  // =====================
  const settingsData = [
    {
      key: "store_name",
      value: "Compusum",
      group: "general",
      label: "Nombre de la tienda",
    },
    {
      key: "store_slogan",
      value: "Tu papelería al por mayor",
      group: "general",
      label: "Slogan",
    },
    {
      key: "store_phone",
      value: "606 333-5206",
      group: "contact",
      label: "Teléfono",
    },
    {
      key: "store_address",
      value: "Carrera 6 #24-14, Pereira, Risaralda",
      group: "contact",
      label: "Dirección",
    },
    {
      key: "store_email",
      value: "info@compusum.com",
      group: "contact",
      label: "Email",
    },
    {
      key: "whatsapp_number",
      value: "576063335206",
      group: "contact",
      label: "WhatsApp",
    },
    {
      key: "instagram",
      value: "@compusumsas",
      group: "social",
      label: "Instagram",
    },
    {
      key: "facebook",
      value: "Compusum S.A.S.",
      group: "social",
      label: "Facebook",
    },
    {
      key: "shipping_info",
      value: "Envíos a todo Colombia",
      group: "shipping",
      label: "Info de envíos",
    },
    {
      key: "primary_color",
      value: "#0D4DAA",
      group: "appearance",
      label: "Color primario",
    },
    {
      key: "secondary_color",
      value: "#6DA8FF",
      group: "appearance",
      label: "Color secundario",
    },
    {
      key: "accent_color",
      value: "#E89A00",
      group: "appearance",
      label: "Color de acento",
    },
  ];

  for (const setting of settingsData) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: { value: setting.value },
      create: setting,
    });
  }
  console.log(`✅ ${settingsData.length} configuraciones creadas`);

  // =====================
  // 7. PRODUCTOS
  // =====================
  console.log("ℹ️ Seed sin productos hardcodeados. Carga el catálogo por importación o panel admin.");

  // =====================
  // 8. CREAR DEPARTAMENTOS Y CIUDADES CON RUTAS (LOGÍSTICA)
  // =====================
  await seedLogistics(prisma);

  console.log("🎉 Seed completado exitosamente!");
}

main()
  .catch((e) => {
    console.error("❌ Error en seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
