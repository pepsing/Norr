#import <UIKit/UIKit.h>

/// Installs layout invalidation for changes in the view's hinge state.
void NorrTrackWindowDivision(UIView * _Nonnull view, void (^ _Nonnull hingeChanged)(BOOL hasHinge, BOOL fullyOpen));
UIRectEdge NorrVerticalBarEdge(UIView * _Nonnull view);
/// Active division in the view's coordinates, or CGRectNull when the window is continuous.
CGRect NorrWindowDivision(UIView * _Nonnull view);
