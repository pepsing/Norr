#import "NorrWindowRegions.h"

void NorrTrackWindowDivision(UIView *view, void (^hingeChanged)(BOOL, BOOL)) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        __weak UIView *target = view;
        [view registerForTraitChanges:UITraitCollection.systemTraitsAffectingVerticalBarEdge withHandler:^(UIView *changedView, UITraitCollection *previous) {
            [changedView setNeedsLayout];
        }];
        [view addInteraction:[[UIHingeInteraction alloc] initWithUpdateHandler:^(UIHingeInteraction *interaction, UIHingeInteractionUpdate *update) {
            hingeChanged(update.hinge != nil, update.hinge.status == UIHingeStatusFullyOpen);
            [target setNeedsLayout];
        }]];
    }
#endif
}

UIRectEdge NorrVerticalBarEdge(UIView *view) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        UIVerticalBarEdge edge = view.traitCollection.verticalBarEdge;
        if (edge == UIVerticalBarEdgeUnspecified) return UIRectEdgeNone;
        BOOL rtl = view.effectiveUserInterfaceLayoutDirection == UIUserInterfaceLayoutDirectionRightToLeft;
        return (edge == UIVerticalBarEdgeLeading) != rtl ? UIRectEdgeLeft : UIRectEdgeRight;
    }
#endif
    return UIRectEdgeNone;
}

CGRect NorrWindowDivision(UIView *view) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        for (UIViewReservedRegion *region in [view reservedRegionsOfKind:UIViewReservedRegionKind.divisionRegionKind]) {
            if (region.isActive && CGRectIntersectsRect(view.bounds, region.frame)) return region.frame;
        }
    }
#endif
    return CGRectNull;
}
