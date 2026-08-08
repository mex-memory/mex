package com.example;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;

interface PaymentGateway {
  void charge();
}

@Service("stripe")
class StripePaymentGateway implements PaymentGateway {
  public void charge() {}
}

@Repository
class InventoryRepository {
  public boolean reserve(String sku) {
    return true;
  }
}

@Service
class OrderService {
  private final PaymentGateway gateway;
  private final InventoryRepository inventory;

  @Autowired
  public OrderService(@Qualifier("stripe") PaymentGateway gateway, InventoryRepository inventory) {
    this.gateway = gateway;
    this.inventory = inventory;
  }

  public OrderDto placeOrder(String sku) {
    inventory.reserve(sku);
    return new OrderDto();
  }
}

@Service
@RequiredArgsConstructor
class ReportService {
  private final InventoryRepository inventory;
}

@Configuration
class CheckoutConfig {
  @Bean(name = "checkout")
  Checkout checkout(PaymentGateway gateway) {
    return new Checkout(gateway);
  }
}

class Checkout {
  Checkout(PaymentGateway gateway) {}
}

class OrderDto {}
