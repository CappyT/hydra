import { useCallback } from "react";
import { useAppDispatch, useAppSelector } from "./redux";
import {
  setHydraCloudModalVisible,
  setHydraCloudModalHidden,
} from "@renderer/features";
import { HydraCloudFeature } from "@types";
import { ACCOUNTLESS } from "@shared";

export function useSubscription() {
  const dispatch = useAppDispatch();

  const { isHydraCloudModalVisible, feature } = useAppSelector(
    (state) => state.subscription
  );

  const showHydraCloudModal = useCallback(
    (feature: HydraCloudFeature) => {
      // Accountless mode: never surface the Hydra Cloud subscription/paywall.
      if (ACCOUNTLESS) return;
      dispatch(setHydraCloudModalVisible(feature));
    },
    [dispatch]
  );

  const hideHydraCloudModal = useCallback(() => {
    dispatch(setHydraCloudModalHidden());
  }, [dispatch]);

  return {
    isHydraCloudModalVisible,
    hydraCloudFeature: feature,
    showHydraCloudModal,
    hideHydraCloudModal,
  };
}
