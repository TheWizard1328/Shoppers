import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { City } from '@/entities/City';
import { AppUser } from '@/entities/AppUser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, Edit, MapPin, Trash2, Truck, Headphones } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import CityForm from '@/components/cities/CityForm';
import DeleteConfirmDialog from '@/components/deliveries/DeleteConfirmDialog';
import { sortCities } from '@/components/utils/sorting';

export default function CitiesPage() {
    const [allCities, setAllCities] = useState([]);
    const [appUsers, setAppUsers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [editingCity, setEditingCity] = useState(null);
    const [deletingCity, setDeletingCity] = useState(null);
    const [showForm, setShowForm] = useState(false);

    const loadCities = useCallback(async () => {
        setIsLoading(true);
        try {
            const [citiesData, usersData] = await Promise.all([
                City.list(),
                AppUser.list()
            ]);
            setAllCities(sortCities(citiesData || []));
            setAppUsers(usersData || []);
        } catch (error) {
            console.error("Failed to load cities:", error);
            setAllCities([]);
            setAppUsers([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadCities();
    }, [loadCities]);

    const handleSaveCity = async (cityData) => {
        try {
            if (editingCity) {
                await City.update(editingCity.id, cityData);
                // Update local state immediately
                setAllCities(prev => sortCities(prev.map(c => c.id === editingCity.id ? { ...c, ...cityData, updated_date: new Date().toISOString() } : c)));
            } else {
                const newCity = await City.create(cityData);
                // Add to local state immediately
                setAllCities(prev => sortCities([...prev, newCity]));
            }
            setShowForm(false); // Using new state name
            setEditingCity(null);
        } catch (error) {
            console.error('Failed to save city:', error);
        }
    };

    const handleDeleteCity = async () => {
        if (!deletingCity) return;
        try {
            await City.delete(deletingCity.id);
            // Update local state immediately
            setAllCities(prev => prev.filter(c => c.id !== deletingCity.id));
            setDeletingCity(null);
        } catch (error) {
            console.error('Failed to delete city:', error);
        }
    };

    const handleDelete = (city) => { // Renamed from openDeleteDialog
        setDeletingCity(city);
    };

    const handleEdit = (city) => { // Renamed from openEditForm
        setEditingCity(city);
        setShowForm(true); // Using new state name
    };
    
    // openCreateForm logic is now directly in the button's onClick handler

    const filteredCities = useMemo(() => 
        allCities.filter(city => 
            (city.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
            (city.province_state || '').toLowerCase().includes(searchTerm.toLowerCase())
        ), [allCities, searchTerm]
    );

    // Calculate driver and dispatcher counts per city
    const getCityCounts = useCallback((cityId) => {
        const cityUsers = appUsers.filter(u => u && u.city_id === cityId && u.status === 'active');
        const drivers = cityUsers.filter(u => u.app_roles?.includes('driver')).length;
        const dispatchers = cityUsers.filter(u => u.app_roles?.includes('dispatcher')).length;
        return { drivers, dispatchers };
    }, [appUsers]);

    return (
        <div className="h-full overflow-y-auto bg-slate-50 p-6">
            <div className="max-w-6xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                    <div className="relative">
                        {isLoading && (
                            <div className="absolute -left-8 top-1/2 -translate-y-1/2">
                                <div className="animate-spin w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full"></div>
                            </div>
                        )}
                        <h1 className="text-3xl font-bold text-slate-900">Cities</h1>
                        <p className="text-slate-600 mt-1">Manage cities and their locations</p>
                    </div>
                    <Button onClick={() => { setEditingCity(null); setShowForm(true); }} className="bg-emerald-600 hover:bg-emerald-700">
                        <Plus className="w-4 h-4 mr-2" />
                        Add City
                    </Button>
                </div>

                {/* Search and Filter */}
                <Card>
                    <CardContent className="p-4">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <Input
                                placeholder="Search cities..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-10"
                            />
                        </div>
                    </CardContent>
                </Card>

                {isLoading ? (
                    <div className="flex justify-center items-center h-64">
                        <div className="text-center">
                            <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                            <p>Loading cities...</p>
                        </div>
                    </div>
                ) : (
                    <>
                        {filteredCities.length === 0 ? (
                            <div className="text-center py-16">
                                <h3 className="text-xl font-semibold text-slate-800">No cities found</h3>
                                <p className="text-slate-500 mt-2">
                                    {searchTerm ? `Your search for "${searchTerm}" did not return any results.` : 'Click "Add City" to get started.'}
                                </p>
                            </div>
                        ) : (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {filteredCities.map((city) => (
                                    <Card key={city.id} className="hover:shadow-lg transition-shadow relative">
                                        {city.sort_order !== undefined && (
                                            <Badge className="absolute top-2 left-2 bg-slate-200 text-slate-700 text-xs">
                                                {city.sort_order}
                                            </Badge>
                                        )}
                                        <CardContent className="p-6">
                                            <div className="flex items-start justify-between mb-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
                                                        <MapPin className="w-6 h-6 text-emerald-600" />
                                                    </div>
                                                    <div>
                                                        <h3 className="font-bold text-lg text-slate-900">{city.name}</h3>
                                                        <p className="text-sm text-slate-500">{city.province_state}, {city.country}</p>
                                                        <p className="text-xs text-slate-400 font-mono mt-1">ID: {city.id}</p>
                                                    </div>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => handleEdit(city)}
                                                >
                                                    <Edit className="w-4 h-4" />
                                                </Button>
                                            </div>

                                            <div className="space-y-2 text-sm">
                                                <div className="flex items-center gap-2 text-slate-600">
                                                    <MapPin className="w-4 h-4" />
                                                    <span>Lat: {city.latitude?.toFixed(6)}, Lng: {city.longitude?.toFixed(6)}</span>
                                                </div>
                                                <div className="flex items-center gap-4 text-slate-600">
                                                    <div className="flex items-center gap-1">
                                                        <Truck className="w-4 h-4 text-emerald-600" />
                                                        <span>{getCityCounts(city.id).drivers} Drivers</span>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <Headphones className="w-4 h-4 text-blue-600" />
                                                        <span>{getCityCounts(city.id).dispatchers} Dispatchers</span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="mt-4 pt-4 border-t border-slate-200">
                                                <Button
                                                    variant="destructive"
                                                    size="sm"
                                                    onClick={() => handleDelete(city)}
                                                    className="w-full"
                                                >
                                                    <Trash2 className="w-4 h-4 mr-2" />
                                                    Delete City
                                                </Button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>

            {showForm && ( // Using new state name
                <CityForm
                    city={editingCity}
                    onSave={handleSaveCity}
                    onCancel={() => {
                        setShowForm(false); // Using new state name
                        setEditingCity(null);
                    }}
                />
            )}

            {deletingCity && (
                <DeleteConfirmDialog
                    open={!!deletingCity}
                    onOpenChange={() => setDeletingCity(null)}
                    onConfirm={handleDeleteCity}
                    title="Delete City"
                    description={`Are you sure you want to delete ${deletingCity.name}? This will also remove the association from any stores or users in this city.`}
                />
            )}
        </div>
    );
}