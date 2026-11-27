#import <UIKit/UIKit.h>

/// Installs layout invalidation for changes in the view's hinge state.
void NorrTrackWindowDivision(UIView * _Nonnull view, void (^ _Nonnull hingeChanged)(BOOL hasHinge, BOOL fullyOpen, BOOL closed));
BOOL NorrSetWindowOrientations(UIViewController * _Nonnull controller, UIInterfaceOrientationMask orientations);
UIRectEdge NorrVerticalBarEdge(UIView * _Nonnull view);
/// Active division in the view's coordinates, or CGRectNull when the window is continuous.
CGRect NorrWindowDivision(UIView * _Nonnull view);
