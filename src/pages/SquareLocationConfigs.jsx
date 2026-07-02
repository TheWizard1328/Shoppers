import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Pencil, Trash2, CreditCard } from "lucide-react";
import { toast } from "sonner";

export default function SquareLocationConfigs() {
  const [configs, setConfigs] = useState([]);
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingConfig, setEditingConfig] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    square_location_id: "",
    status: "active",
    notes: "",
    selectedStoreIds: [] // local only — used to update Store.square_location_config_id
  });

  // Subscribe to live Store updates via WebSocket
  useEffect(() => {
    const unsubscribe = base44.entities.Store.subscribe((event) => {
      if (event.type === 'create') {
        setStores((prev) => [...prev, event.data]);
      } else if (event.type === 'update') {
        setStores((prev) => prev.map((s) => s.id === event.data.id ? { ...s, ...event.data } : s));
      } else if (event.type === 'delete') {
        setStores((prev) => prev.filter((s) => s.id !== event.id));
      }
    });
    return unsubscribe;
  }, []);

  // Hydrate stores from offline IndexedDB immediately on mount
  useEffect(() => {
    (async () => {
      try {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
        if ((offlineStores || []).length > 0) setStores(offlineStores);
      } catch (_) { /* non-critical */ }
    })();
    loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [configsData, storesData] = await Promise.all([
        base44.entities.SquareLocationConfig.list(),
        base44.entities.Store.list()
      ]);
      setConfigs(configsData || []);
      if ((storesData || []).length > 0) setStores(storesData);
    } catch (error) {
      console.error("Failed to load data:", error);
      toast.error("Failed to load Square location configs");
    } finally {
      setIsLoading(false);
    }
  };

  // Returns all stores linked to this config via store.square_location_config_id
  const getLinkedStores = (config) =>
    stores.filter((s) => s?.square_location_config_id === config.id);

  const handleOpenDialog = (config = null) => {
    if (config) {
      setEditingConfig(config);
      const linked = stores.filter((s) => s?.square_location_config_id === config.id).map((s) => s.id);
      setFormData({
        name: config.name || "",
        square_location_id: config.square_location_id || "",
        status: config.status || "active",
        notes: config.notes || "",
        selectedStoreIds: linked
      });
    } else {
      setEditingConfig(null);
      setFormData({ name: "", square_location_id: "", status: "active", notes: "", selectedStoreIds: [] });
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingConfig(null);
    setFormData({ name: "", square_location_id: "", status: "active", notes: "", selectedStoreIds: [] });
  };

  const toggleStoreId = (storeId) => {
    setFormData((prev) => {
      const exists = prev.selectedStoreIds.includes(storeId);
      return {
        ...prev,
        selectedStoreIds: exists
          ? prev.selectedStoreIds.filter((id) => id !== storeId)
          : [...prev.selectedStoreIds, storeId]
      };
    });
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.square_location_id.trim()) {
      toast.error("Name and Square Location ID are required");
      return;
    }

    try {
      let configId = editingConfig?.id;
      const payload = {
        name: formData.name,
        square_location_id: formData.square_location_id,
        status: formData.status,
        notes: formData.notes
      };

      if (editingConfig) {
        await base44.entities.SquareLocationConfig.update(configId, payload);
      } else {
        const created = await base44.entities.SquareLocationConfig.create(payload);
        configId = created.id;
      }

      // Update all stores: link selected ones to this config, unlink previously-linked ones
      const previouslyLinked = stores
        .filter((s) => s?.square_location_config_id === editingConfig?.id)
        .map((s) => s.id);

      const toUnlink = previouslyLinked.filter((id) => !formData.selectedStoreIds.includes(id));
      const toLink = formData.selectedStoreIds;

      await Promise.all([
        ...toUnlink.map((id) => base44.entities.Store.update(id, { square_location_config_id: "" })),
        ...toLink.map((id) => base44.entities.Store.update(id, { square_location_config_id: configId }))
      ]);

      toast.success(editingConfig ? "Square location config updated" : "Square location config created");
      handleCloseDialog();
      loadData();
    } catch (error) {
      console.error("Failed to save config:", error);
      toast.error("Failed to save Square location config");
    }
  };

  const handleDelete = async (config) => {
    if (!window.confirm(`Are you sure you want to delete "${config.name}"?`)) return;
    try {
      // Unlink all stores pointing to this config
      const linked = stores.filter((s) => s?.square_location_config_id === config.id);
      await Promise.all(linked.map((s) => base44.entities.Store.update(s.id, { square_location_config_id: "" })));
      await base44.entities.SquareLocationConfig.delete(config.id);
      toast.success("Square location config deleted");
      loadData();
    } catch (error) {
      console.error("Failed to delete config:", error);
      toast.error("Failed to delete Square location config");
    }
  };

  const sortedStores = [...stores].filter(Boolean).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Square Location Configs</h1>
          <p className="text-slate-500 mt-1">Manage Square Location IDs for COD processing</p>
        </div>
        <Button onClick={() => handleOpenDialog()} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
          <Plus className="w-4 h-4" />
          Add Location
        </Button>
      </div>

      {configs.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <CreditCard className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-900 mb-2">No Square Locations Configured</h3>
            <p className="text-slate-500 mb-4">Add your first Square Location ID to start processing COD payments.</p>
            <Button onClick={() => handleOpenDialog()} className="gap-2">
              <Plus className="w-4 h-4" />
              Add Location
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {[...configs].sort((a, b) => {
            const statusDiff = (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1);
            if (statusDiff !== 0) return statusDiff;
            const aMin = getLinkedStores(a).reduce((m, s) => Math.min(m, s.sort_order ?? Infinity), Infinity);
            const bMin = getLinkedStores(b).reduce((m, s) => Math.min(m, s.sort_order ?? Infinity), Infinity);
            return aMin - bMin;
          }).map((config) => {
            const linkedStores = getLinkedStores(config);
            return (
              <Card key={config.id} className={config.status === "inactive" ? "opacity-60" : ""}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                        <CreditCard className="w-5 h-5 text-emerald-600" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">{config.name}</CardTitle>
                        <code className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded mt-1 inline-block">
                          {config.square_location_id}
                        </code>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={config.status === "active" ? "bg-green-600 text-white hover:bg-green-600" : "bg-red-600 text-white hover:bg-red-600"}>
                        {config.status}
                      </Badge>
                      <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(config)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(config)} className="text-red-500 hover:text-red-700 hover:bg-red-50">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {config.notes && <p className="text-sm text-slate-600 mb-3">{config.notes}</p>}
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-slate-500">Stores:</span>
                    {linkedStores.length > 0 ? (
                      [...linkedStores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)).map((s) => (
                        <Badge key={s.id} className="text-xs text-white border-0" style={{ backgroundColor: s.color || '#64748b' }}>{s.name}</Badge>
                      ))
                    ) : (
                      <span className="text-slate-400 italic">No stores linked</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingConfig ? "Edit Square Location" : "Add Square Location"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="name">Config Name *</Label>
                <Input
                  id="name"
                  placeholder="e.g., Main Terminal"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[60003]">
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Stores</Label>
              <div className="border rounded-md max-h-44 overflow-y-auto p-2 space-y-1">
                {sortedStores.length === 0 && (
                  <p className="text-sm text-slate-400 italic px-1">No stores available</p>
                )}
                {sortedStores.map((store) => (
                  <label key={store.id} className="flex items-center gap-2 cursor-pointer rounded px-2 py-1 hover:bg-slate-50">
                    <Checkbox
                      checked={formData.selectedStoreIds.includes(store.id)}
                      onCheckedChange={() => toggleStoreId(store.id)} />
                    <span className="text-sm">{store.name}</span>
                    {store.square_location_config_id && store.square_location_config_id !== editingConfig?.id && (
                      <span className="text-xs text-amber-500 ml-auto">linked elsewhere</span>
                    )}
                  </label>
                ))}
              </div>
              {formData.selectedStoreIds.length > 0 && (
                <p className="text-xs text-slate-500">{formData.selectedStoreIds.length} store{formData.selectedStoreIds.length > 1 ? "s" : ""} selected</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="square_location_id">Square Location ID *</Label>
              <Input
                id="square_location_id"
                placeholder="e.g., L8Y3..."
                value={formData.square_location_id}
                onChange={(e) => setFormData({ ...formData, square_location_id: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Optional notes about this location..."
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>Cancel</Button>
            <Button onClick={handleSave} className="bg-emerald-600 hover:bg-emerald-700">
              {editingConfig ? "Save Changes" : "Add Location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}