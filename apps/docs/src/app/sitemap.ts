import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  const docPages = source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
  }));

  const staticRoutes = ['/', '/docs/install'].map((path) => ({
    url: `${siteUrl}${path}`,
  }));

  return [...staticRoutes, ...docPages];
}
