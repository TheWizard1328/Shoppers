export const sortStores = (stores) => {
    if (!Array.isArray(stores)) return [];
    return [...stores].sort((a, b) => {
        const orderA = a.sort_order ?? Infinity;
        const orderB = b.sort_order ?? Infinity;
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return (a.name || '').localeCompare(b.name || '');
    });
};