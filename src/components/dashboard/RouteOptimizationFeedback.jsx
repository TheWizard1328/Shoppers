import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X, ThumbsUp, ThumbsDown, MessageSquare, Send, Route } from 'lucide-react';
import { base44 } from '@/api/base44Client';

/**
 * Driver Feedback Modal for Route Optimization
 * Collects driver feedback on optimized routes to improve AI model
 */
export default function RouteOptimizationFeedback({ 
  isOpen, 
  onClose, 
  driverId,
  deliveryDate,
  optimizationData // Contains: { routeChanged, totalStops, oldOrder, newOrder, apiCallsMade }
}) {
  const [rating, setRating] = useState(null); // 'helpful' | 'not_helpful'
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!rating) {
      alert('Please rate the route optimization');
      return;
    }

    setIsSubmitting(true);
    
    try {
      await base44.entities.DriverAssistantFeedback.create({
        driver_id: driverId,
        suggestion_type: 'reroute',
        suggestion_text: `Route optimization ${optimizationData.routeChanged ? 'changed' : 'maintained'} route order for ${optimizationData.totalStops} stops`,
        driver_feedback: rating === 'helpful' ? 'followed' : 'not_helpful',
        context: {
          delivery_date: deliveryDate,
          stops_total: optimizationData.totalStops,
          route_changed: optimizationData.routeChanged,
          api_calls_made: optimizationData.apiCallsMade,
          old_order: optimizationData.oldOrder,
          new_order: optimizationData.newOrder
        },
        outcome: {
          action_taken: rating === 'helpful' ? 'Route accepted' : 'Route rejected',
          feedback_notes: feedback || null
        }
      });

      // Close modal after successful submission
      onClose();
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      alert('Failed to submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10020] bg-black/60 flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Route className="w-5 h-5 text-blue-600" />
                <h3 className="text-lg font-bold text-slate-900">
                  Route Feedback
                </h3>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                disabled={isSubmitting}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-sm text-slate-600 mb-3">
                  How was the optimized route for this delivery?
                </p>
                
                <div className="flex gap-3">
                  <Button
                    variant={rating === 'helpful' ? 'default' : 'outline'}
                    className={`flex-1 gap-2 ${rating === 'helpful' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                    onClick={() => setRating('helpful')}
                    disabled={isSubmitting}
                  >
                    <ThumbsUp className="w-4 h-4" />
                    Helpful
                  </Button>
                  
                  <Button
                    variant={rating === 'not_helpful' ? 'default' : 'outline'}
                    className={`flex-1 gap-2 ${rating === 'not_helpful' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}`}
                    onClick={() => setRating('not_helpful')}
                    disabled={isSubmitting}
                  >
                    <ThumbsDown className="w-4 h-4" />
                    Not Helpful
                  </Button>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Additional Comments (Optional)
                </label>
                <Textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Share your thoughts on the route optimization..."
                  className="h-24 resize-none"
                  disabled={isSubmitting}
                />
              </div>

              <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600">
                <p className="font-medium mb-1">Route Info:</p>
                <p>• {optimizationData.totalStops} total stops</p>
                <p>• Route {optimizationData.routeChanged ? 'was reordered' : 'kept same order'}</p>
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={onClose}
                  disabled={isSubmitting}
                >
                  Skip
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!rating || isSubmitting}
                  className="bg-blue-600 hover:bg-blue-700 gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Submit Feedback
                    </>
                  )}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}