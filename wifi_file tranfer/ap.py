# 导入必要的模块 / Import required modules
import network  # 网络相关功能模块 / Network functionality module
import time     # 时间相关功能模块 / Time functionality module

# 定义WiFi热点的名称和密码 / Define WiFi hotspot name and password
AP_SSID = 'YAHBOOM-K230'  # 热点名称 / Hotspot name
AP_KEY = '12345678'       # 至少8位密码 / Password (minimum 8 characters)

def CREATE_AP(AP_SSID, AP_KEY):
    """
    创建并配置WiFi热点 / Create and configure WiFi hotspot
    
    参数 / Parameters:
    AP_SSID: 热点名称 / Hotspot name
    AP_KEY: 热点密码 / Hotspot password
    """
    
    # 初始化AP模式,创建WLAN对象 / Initialize AP mode, create WLAN object
    ap = network.WLAN(network.AP_IF)

    # 激活AP模式 / Activate AP mode
    if not ap.active():
        ap.active(True)
    print("AP模式激活状态 / AP mode activation status:", ap.active())

    # 配置热点参数(SSID和密码) / Configure hotspot parameters (SSID and password)
    ap.config(ssid=AP_SSID, key=AP_KEY)
    print("\n热点已创建 / Hotspot created:")
    print(f"SSID: {AP_SSID}")
    print(f"KEY: {AP_KEY}")

    # 等待热点启动（暂定3秒）/ Wait for hotspot to start (3 seconds)
    time.sleep(3)

    # 获取并打印IP信息 / Get and print IP information
    ip_info = ap.ifconfig()
    print("\nAP 网络配置 / AP network configuration:")
    print(f"IP 地址 / IP address: {ip_info[0]}")
    print(f"子网掩码 / Subnet mask: {ip_info[1]}")
    print(f"网关 / Gateway: {ip_info[2]}")
    print(f"DNS 服务器 / DNS server: {ip_info[3]}")

    # 持续监控连接设备 / Continuously monitor connected devices
    while True:
        # 获取已连接的客户端信息 / Get information about connected clients
        clients = ap.status('stations')
        print(f"\n已连接设备数 / Number of connected devices: {len(clients)}")

        # 每秒更新一次 / Update every second
        time.sleep(1)

# 调用函数创建热点 / Call function to create hotspot
CREATE_AP(AP_SSID, AP_KEY)