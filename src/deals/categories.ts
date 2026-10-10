/** What a buyer can pick as the order's category (the form's dropdown and the chat list use the same list). */
export const CATEGORIES = [
  { id: 'food', title: 'Food & drinks' },
  { id: 'clothing', title: 'Clothing' },
  { id: 'shoes', title: 'Shoes' },
  { id: 'bags', title: 'Bags & accessories' },
  { id: 'beauty', title: 'Beauty & hair' },
  { id: 'phones', title: 'Phones & gadgets' },
  { id: 'electronics', title: 'Electronics' },
  { id: 'appliances', title: 'Home appliances' },
  { id: 'home', title: 'Furniture & home' },
  { id: 'other', title: 'Something else' },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]['id'];
export const categoryTitle = (id: string | null | undefined): string | null => CATEGORIES.find((c) => c.id === id)?.title ?? null;
export const isCategory = (id: unknown): id is CategoryId => CATEGORIES.some((c) => c.id === id);
