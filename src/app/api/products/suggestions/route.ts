import { NextResponse } from 'next/server';
import { searchProductSuggestions } from '@/lib/product-search';
import { isGlobalCatalogModeEnabled, sanitizeProductsForCatalog } from '@/lib/catalog-mode';

// GET /api/products/suggestions?q=term - Quick autocomplete suggestions
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || '';

    if (query.length < 2) {
      return NextResponse.json({ suggestions: [] });
    }

    const [isCatalogMode, suggestions] = await Promise.all([
      isGlobalCatalogModeEnabled(),
      searchProductSuggestions(query, 5),
    ]);

    const sanitizedSuggestions = sanitizeProductsForCatalog(suggestions, isCatalogMode);

    return NextResponse.json({ suggestions: sanitizedSuggestions });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    return NextResponse.json({ suggestions: [] });
  }
}
