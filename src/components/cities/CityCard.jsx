
import React from "react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Edit, Trash2, Users, Building, GripVertical } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function CityCard({ city, onEdit, onDelete, cityStats, dragHandleProps }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.2 }}
        >
            <Card className="bg-white border-slate-200 shadow-sm hover:shadow-md transition-shadow duration-300 h-full">
                <CardContent className="p-6 flex flex-col justify-between h-full">
                    <div>
                        <div className="flex items-start justify-between mb-4">
                            <div className="flex items-center gap-3">
                                <div className="w-12 h-12 bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl flex items-center justify-center">
                                    <Building2 className="w-6 h-6 text-blue-600" />
                                </div>
                                <div>
                                    <h3 className="font-semibold text-slate-900 text-lg">
                                        {city.name}
                                    </h3>
                                    <p className="text-sm text-slate-600">
                                        {city.province_state}, {city.country}
                                    </p>
                                </div>
                            </div>
                            <div {...dragHandleProps} className="cursor-grab text-slate-400 hover:text-slate-600">
                                <GripVertical className="w-5 h-5" />
                            </div>
                        </div>

                        {/* City Statistics */}
                        <div className="space-y-3 mb-4">
                            <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2">
                                    <Users className="w-4 h-4 text-emerald-600" />
                                    <span className="text-slate-600 font-medium">Drivers</span>
                                </div>
                                <span className="font-semibold text-slate-900">{cityStats?.drivers || 0}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2">
                                    <Building className="w-4 h-4 text-purple-600" />
                                    <span className="text-slate-600 font-medium">Stores</span>
                                </div>
                                <span className="font-semibold text-slate-900">{cityStats?.stores || 0}</span>
                            </div>
                        </div>

                        <div className="text-xs text-slate-400 font-mono mt-3">
                            {city.latitude?.toFixed(7)}, {city.longitude?.toFixed(7)}
                        </div>
                    </div>
                    
                    <div className="mt-6 flex justify-end gap-2">
                         <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button variant="destructive" size="sm">
                                    <Trash2 className="w-4 h-4 mr-2" />
                                    Delete
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Delete City</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        Are you sure you want to delete {city.name}? This action cannot be undone.
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                        onClick={() => onDelete(city.id)}
                                        className="bg-red-600 hover:bg-red-700"
                                    >
                                        Delete
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onEdit(city)}
                        >
                            <Edit className="w-4 h-4 mr-2" />
                            Edit
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </motion.div>
    );
}
