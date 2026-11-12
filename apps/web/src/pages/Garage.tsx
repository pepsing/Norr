import { useState } from "react";
import { ArrowLeft, ArrowRight, CarFront, Plus } from "lucide-react";
import { demoCapabilityProfile, makeVehicle, useWorkspace } from "../workspace";
import type { DemoVehicle } from "../workspace";
import { Confirmation } from "../components/WorkspaceUI";
import { Modal } from "../components/Modal";
import { VehicleArtwork } from "../components/VehicleArtwork";
import { VehicleAppearancePicker } from "../components/VehicleAppearancePicker";
import {
  appearanceFor,
  appearanceDetails,
  defaultAppearance,
  vehicleConfiguration,
} from "../vehicle-catalog";

export function Garage({ onSelect }: { onSelect: () => void }) {
  const {
    data,
    setData,
    vehicle,
    busy,
    removeVehicle,
    setScenario,
    setNotice,
  } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [stage, setStage] = useState(0);
  const [brand, setBrand] = useState<DemoVehicle["brand"]>("Polestar");
  const [region, setRegion] = useState<DemoVehicle["region"]>("国际区");
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<DemoVehicle | null>(null);
  const [editing, setEditing] = useState<DemoVehicle | null>(null);
  const [appearance, setAppearance] = useState(defaultAppearance);
  function connect() {
    if (region === "中国区" && code !== "123456") {
      setError("请输入界面提供的演示验证码 123456。");
      return;
    }
    const next = makeVehicle(
      brand,
      region,
      nickname.trim() || `我的 ${brand}`,
      appearance,
    );
    setData((old) => ({
      ...old,
      vehicles: [...old.vehicles, next],
      selected: next.id,
    }));
    setScenario("connected");
    setAdding(false);
    setNotice("已添加演示车辆");
    onSelect();
  }
  if (adding)
    return (
      <div className="onboarding-layout">
        <section className="onboarding-intro">
          <p className="eyebrow">连接车辆</p>
          <h2>
            连接你的
            <br />
            {brand}
          </h2>
          <p>选择品牌与地区，预览对应的登录和车辆发现流程。</p>
          <div className="flow-steps">
            {["品牌与地区", "授权验证", "选择车辆"].map((step, index) => (
              <span
                key={step}
                aria-current={index === stage ? "step" : undefined}
              >
                {step}
              </span>
            ))}
          </div>
          <p className="muted">
            登录演示使用本地数据。短信步骤提供示例验证码，授权步骤模拟厂商回调。
          </p>
        </section>
        <section className="form-panel">
          <button
            className="text-button"
            onClick={() => {
              if (stage > 0) setStage(stage - 1);
              else setAdding(false);
              setError("");
            }}
          >
            <ArrowLeft size={16} />
            {stage ? "上一步" : "返回车库"}
          </button>
          {stage === 0 && (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                setStage(1);
              }}
            >
              <h2>你的车辆</h2>
              <label>
                车辆品牌
                <select
                  value={brand}
                  onChange={(e) => {
                    setBrand(e.target.value as DemoVehicle["brand"]);
                    setRegion("国际区");
                  }}
                >
                  <option>Polestar</option>
                  <option>Volvo</option>
                </select>
              </label>
              <label>
                账号地区
                <select
                  value={region}
                  onChange={(e) =>
                    setRegion(e.target.value as DemoVehicle["region"])
                  }
                >
                  <option>国际区</option>
                  {brand === "Polestar" && <option>中国区</option>}
                </select>
              </label>
              <label>
                车辆昵称
                <input
                  maxLength={30}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="例如，我的 Polestar"
                />
              </label>
              {region === "中国区" && (
                <p className="muted">
                  中国区 Polestar 2 可预览核心控制与定时。Polestar 4
                  的服务适配仍待验证。
                </p>
              )}
              <button className="primary-button">
                继续
                <ArrowRight size={17} />
              </button>
            </form>
          )}
          {stage === 1 && (
            <div className="form-stack">
              <h2>{region === "中国区" ? "短信登录" : `${brand} ID 授权`}</h2>
              {region === "中国区" ? (
                <form
                  className="form-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setStage(2);
                    setError("");
                  }}
                >
                  <label>
                    演示手机号
                    <input
                      type="tel"
                      inputMode="numeric"
                      required
                      pattern="1[0-9]{10}"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="11 位号码，用于表单校验"
                    />
                  </label>
                  <p className="muted">
                    继续后模拟验证码验证成功，并显示短信验证码输入页。
                  </p>
                  <button className="primary-button">完成演示验证并继续</button>
                </form>
              ) : (
                <>
                  <p>在厂商授权页登录后，应用接收回调并获取车辆列表。</p>
                  <p className="muted">
                    本预览可直接模拟授权成功，也可以返回取消。
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => setStage(2)}
                  >
                    模拟授权成功
                  </button>
                </>
              )}
            </div>
          )}
          {stage === 2 && (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                connect();
              }}
            >
              <h2>
                {region === "中国区" ? "验证并添加车辆" : "选择发现的车辆"}
              </h2>
              {region === "中国区" && (
                <>
                  <p>演示验证码为 123456。</p>
                  <label>
                    短信验证码
                    <input
                      autoComplete="off"
                      required
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setNotice("演示验证码仍为 123456")}
                  >
                    重新获取演示码
                  </button>
                </>
              )}
              {brand === "Polestar" ? (
                <VehicleAppearancePicker
                  value={appearance}
                  onChange={setAppearance}
                />
              ) : (
                <div className="discovered-vehicle">
                  <CarFront size={32} />
                  <div>
                    <h3>Volvo XC60</h3>
                    <p>{region} · 演示车辆</p>
                  </div>
                </div>
              )}
              {error && (
                <p role="alert" className="danger-text">
                  {error}
                </p>
              )}
              <button className="primary-button">添加到车库</button>
            </form>
          )}
        </section>
      </div>
    );
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>我的车库</h2>
          <p className="muted">
            {data.vehicles.length} 辆演示车辆 · 各车独立保存控制与计划
          </p>
        </div>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => {
            setAdding(true);
            setStage(0);
            setCode("");
            setPhone("");
            setNickname("");
            setAppearance(defaultAppearance());
          }}
        >
          <Plus size={17} />
          添加车辆
        </button>
      </div>
      <div className="garage-grid">
        {data.vehicles.map((car) => (
          <article className="garage-vehicle" key={car.id}>
            <div className="vehicle-heading">
              <h2>{car.nickname}</h2>
              {vehicle?.id === car.id && (
                <span className="muted">当前车辆</span>
              )}
            </div>
            {car.brand === "Polestar" ? (
              <VehicleArtwork appearance={appearanceFor(car)} />
            ) : (
              <div className="art-placeholder">
                <CarFront size={64} strokeWidth={1} />
                <span>Volvo XC60 · 图片待接入</span>
              </div>
            )}
            <h3>{car.model}</h3>
            <p className="garage-configuration">
              {car.variant}
              {car.brand === "Polestar" &&
                ` · ${appearanceDetails(appearanceFor(car)).color.name}`}
            </p>
            <p>
              {car.region} ·{" "}
              {car.brand === "Polestar" ? "纯电动" : "插电式混合动力"}
            </p>
            <div className="button-row">
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => {
                  setData((old) => ({ ...old, selected: car.id }));
                  setScenario("connected");
                  onSelect();
                }}
              >
                查看车辆
                <ArrowRight size={17} />
              </button>
              {car.brand === "Polestar" && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setAppearance(appearanceFor(car));
                    setEditing(car);
                  }}
                >
                  车型与外观
                </button>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setRemoving(car)}
              >
                移除
              </button>
            </div>
          </article>
        ))}
      </div>
      {!data.vehicles.length && (
        <div className="inline-empty">
          <CarFront size={48} />
          <h2>车库中还没有车辆</h2>
          <p>添加品牌账号，继续体验连接与车辆发现流程。</p>
        </div>
      )}
      {editing && (
        <Modal title="车型与外观" onClose={() => setEditing(null)}>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              setData((old) => ({
                ...old,
                vehicles: old.vehicles.map((car) =>
                  car.id === editing.id
                    ? {
                        ...car,
                        ...vehicleConfiguration(appearance),
                        ...(car.model !== vehicleConfiguration(appearance).model
                          ? {
                              ...demoCapabilityProfile(
                                car.brand,
                                car.region,
                                vehicleConfiguration(appearance).model,
                              ),
                              scheduleReads: {},
                            }
                          : {}),
                      }
                    : car,
                ),
              }));
              setEditing(null);
              setNotice("演示车型与外观已保存");
            }}
          >
            <VehicleAppearancePicker
              value={appearance}
              onChange={setAppearance}
            />
            <div className="button-row">
              <button className="primary-button" disabled={busy}>
                保存外观
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </div>
          </form>
        </Modal>
      )}
      {removing && (
        <Confirmation
          title="移除演示车辆"
          confirm="确认移除"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            removeVehicle(removing.id);
            setRemoving(null);
          }}
        >
          <p>
            将从此浏览器移除 {removing.nickname} 的演示快照、计划和操作记录。
          </p>
        </Confirmation>
      )}
    </>
  );
}
