import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import { motion } from "framer-motion";

const colorConfig = {
  blue: "from-blue-500 to-blue-600 text-blue-600",
  emerald: "from-emerald-500 to-emerald-600 text-emerald-600",
  green: "from-green-500 to-green-600 text-green-600",
  purple: "from-purple-500 to-purple-600 text-purple-600"
};

export default function StatsCard({ title, value, icon: Icon, trend, color, isLocationSharing }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}
    >
      <Card className={`bg-white shadow-sm hover:shadow-md transition-shadow duration-300 ${
        isLocationSharing ? 'border-2 border-emerald-500' : 'border-slate-200'
      }`}>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600 mb-1">{title}</p>
              <p className="text-3xl font-bold text-slate-900">{value}</p>
            </div>
            <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${colorConfig[color]} bg-opacity-10 flex items-center justify-center`}>
              <Icon className={`w-6 h-6 ${colorConfig[color].split(' ')[2]}`} />
            </div>
          </div>
          {trend && (
            <div className="flex items-center mt-4 text-sm">
              <TrendingUp className="w-4 h-4 mr-1 text-emerald-500" />
              <span className="text-slate-600">{trend}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}