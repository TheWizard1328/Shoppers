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
import { Plus, Pencil, Trash2, CreditCard, AlertCircle, RefreshCw, MapPin, DollarSign } from "lucide-react";
import { toast } from "sonner";

export default function SquareLocationConfigs() {
  const [configs, setConfigs] = useState([]);
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [locationDetails, setLocationDetails] = useState({});
  const [isFetchingBalances, setIsFetchingBalances] = useState(false);
  const [editingConfig, setEditingConfig] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    square_location_id: "",
    status: "active",
    notes: ""
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [configsData, storesData] = await Promise.all([
        base44.entities.SquareLocationConfig.list(),
        base44.entities.Store.list()
      ]);
      setConfigs(configsData || []);
      setStores(storesData || []);
      
      // Fetch location details from Square
      fetchLocationBalances();
    } catch (error) {
      console.error("Failed to load data:", error);
      toast.error("Failed to load Square location configs");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchLocationBalances = async () => {
    setIsFetchingBalances(true);
    try {
      const response = await base44.functions.invoke('getSquareLocationBalances');
      const data = response?.data || response;
      
      if (data?.locations) {
        const detailsMap = {};
        data.locations.forEach(loc => {
          detailsMap[loc.configId] = loc;
        });
        setLocationDetails(detailsMap);
      }
    } catch (error) {
      console.error("Failed to fetch Square location details:", error);
    } finally {
      setIsFetchingBalances(false);
    }
  };

  const handleOpenDialog = (config = null) => {
    if (config) {
      setEditingConfig(config);
      setFormData({
        name: config.name || "",
        square_location_id: config.square_location_id || "",
        status: config.status || "active",
        notes: config.notes || ""
      });
    } else {
      setEditingConfig(null);
      setFormData({
        name: "",
        square_location_id: "",
        status: "active",
        notes: ""
      });
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingConfig(null);
    setFormData({
      name: "",
      square_location_id: "",
      status: "active",
      notes: ""
    });
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.square_location_id.trim()) {
      toast.error("Name and Square Location ID are required");
      return;
    }

    try {
      if (editingConfig) {
        await base44.entities.SquareLocationConfig.update(editingConfig.id, formData);
        toast.success("Square location config updated");
      } else {
        await base44.entities.SquareLocationConfig.create(formData);
        toast.success("Square location config created");
      }
      handleCloseDialog();
      loadData();
    } catch (error) {
      console.error("Failed to save config:", error);
      toast.error("Failed to save Square location config");
    }
  };

  const handleDelete = async (config) => {
    // Check if any stores are using this config
    const storesUsingConfig = stores.filter(s => s.square_location_config_id === config.id);
    if (storesUsingConfig.length > 0) {
      toast.error(`Cannot delete: ${storesUsingConfig.length} store(s) are using this location config`);
      return;
    }

    if (!window.confirm(`Are you sure you want to delete "${config.name}"?`)) {
      return;
    }

    try {
      await base44.entities.SquareLocationConfig.delete(config.id);
      toast.success("Square location config deleted");
      loadData();
    } catch (error) {
      console.error("Failed to delete config:", error);
      toast.error("Failed to delete Square location config");
    }
  };

  const getAssignedStores = (configId) => {
    return stores.filter(s => s.square_location_config_id === configId);
  };

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
        <div className="flex items-center gap-2">
          <Button 
            variant="outline" 
            onClick={fetchLocationBalances} 
            disabled={isFetchingBalances}
            className="gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isFetchingBalances ? 'animate-spin' : ''}`} />
            Refresh from Square
          </Button>
          <Button onClick={() => handleOpenDialog()} className="gap-2 bg-emerald-600 hover:bg-emerald-700">
            <Plus className="w-4 h-4" />
            Add Location
          </Button>
        </div>
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
          {configs.map((config) => {
            const assignedStores = getAssignedStores(config.id);
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
                      <Badge variant={config.status === "active" ? "default" : "secondary"}>
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
                  {config.notes && (
                    <p className="text-sm text-slate-600 mb-3">{config.notes}</p>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-slate-500">Assigned to:</span>
                    {assignedStores.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {assignedStores.map(store => (
                          <Badge key={store.id} variant="outline" className="text-xs">
                            {store.name}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-400 italic">No stores assigned</span>
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
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                placeholder="e.g., Main Terminal, Driver 1 Card"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="square_location_id">Square Location ID *</Label>
              <Input
                id="square_location_id"
                placeholder="e.g., L8Y3..."
                value={formData.square_location_id}
                onChange={(e) => setFormData({ ...formData, square_location_id: e.target.value })}
              />
              <p className="text-xs text-slate-500">Find this in your Square Dashboard under Locations</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Optional notes about this location..."
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={3}
              />
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